#!/usr/bin/env node
/**
 * test:dataroom-folders — the data room's folder names are a setting of the deployment, and a deployment that
 * already holds files keeps every one of them where it is.
 *
 * The folder names used to be written into the code, in the words of the line of work the base product was built
 * for. They are the deployment profile's now (profiles/*.json `dataroom.domains.<id>.folder`, `uploads_folder`;
 * agent/lib/dataroom-folders.ts): the default profile's are neutral, and a deployment whose data room was filled
 * before pins the names it has. This proves the four things that makes true:
 *
 *   1. THE PROFILE. The default stores under neutral names; a profile may state a folder, by the domain's id or by
 *      the key it had before; a name that is not a folder, two domains in one folder and a label that would be read
 *      as another domain's folder are refused; and a profile written with the old keys that does not say where its
 *      files are is REFUSED at build, with the line to add.
 *   2. THE PIN MOVES NOTHING. A copy of this checkout is stamped with the pin (scripts/fixtures/dataroom-folders/
 *      50-legacy-folders.json, the exact lines a pack adds) and, inside it:
 *        - the stored-path census (scripts/lib/dataroom-path-census.mjs: the path grammar, a real file written,
 *          listed and read at every template, the agent's tools run offline, the workbooks, the web guards, a new
 *          workspace's starter files, both seeders' trees) is byte for byte the one taken on the last commit before
 *          the names were a setting (stored-paths-before.json);
 *        - every door to the store, driven for real by scripts/test-dataroom-isolation.mjs (the agent's store on
 *          both drivers, the web routes: read, list, upload, export, versions, PDF preview, the workflow reader, the
 *          root migration), asks for exactly the object keys it asked for then (keys-before.json);
 *        - the suites that read and write the data room pass unchanged.
 *      (What the pinned deployment's MODEL reads is held the same way by npm run check:agent-vocabulary.)
 *   3. THE DEFAULT IS THE SAME TREE UNDER OTHER NAMES. The same census in this checkout differs from the
 *      before-image in the first segment of a path and in nothing else.
 *   4. THE SAFETY NET. A data room that holds a former folder the profile does not use is refused: at build by
 *      scripts/check-dataroom-folders.mjs (both stores), and at the first write by the agent's store (both drivers)
 *      and the web app's twin, with a plain message and the lines to add; nothing is written beside the old files.
 *
 * On the commit before this one it fails at the first import: there was no profile setting, no census, no guard.
 *
 *   npm run test:dataroom-folders
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// The web app's `@/` alias, extensionless imports and Next's `server-only` guard, so lib/dataroom-blob.ts loads here.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(ROOT + "/").href)};
      export async function resolve(s, c, n) {
        if (s === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) return await n(s + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

let passed = 0;
const failed = [];
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).split("\n").slice(0, 14).join("\n       ")}`);
  }
};
const FIXTURES = join(ROOT, "scripts/fixtures/dataroom-folders");
const PIN_FILE = join(FIXTURES, "50-legacy-folders.json");
const NODE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
const scratch = [];
const tmp = (name) => {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  scratch.push(dir);
  return dir;
};

const folders = await imp("agent/lib/dataroom-folders.ts");
const guard = await imp("agent/lib/dataroom-folder-guard.ts");
const { legacyFolders, storedFoldersOfTree } = await imp("scripts/lib/profile-folders.mjs");
const { FOLDER } = folders;
// The names the folders had while they were in the code: read from their one definition, never written here.
const FORMER = legacyFolders(ROOT);
const IDS = [...folders.DATAROOM_DOMAIN_IDS];
/** The domains whose default folder is no longer the former one: the only ones a deployment can leave behind. */
const RENAMED = IDS.filter((id) => FOLDER[id] !== FORMER[id]);

/* ---- 1. the profile ---------------------------------------------------------------------------------------------- */

/** The real generator over the default profile plus these files: { status, profile, err }. */
function generate(extra = {}) {
  const dir = tmp("folders-profiles");
  cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
  for (const [name, doc] of Object.entries(extra)) writeFileSync(join(dir, name), typeof doc === "string" ? doc : JSON.stringify(doc));
  const r = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
  return { status: r.status, err: r.stderr, profile: r.status === 0 ? JSON.parse(r.stdout) : null };
}
const room = (domains, more = {}) => ({ dataroom: { domains, ...more } });

console.log("\n1. The profile says where each domain is stored");
await check("the default profile stores every domain under a folder of its own, and reads each under that folder's name", () => {
  const { profile, err } = generate();
  assert.ok(profile, err);
  assert.deepEqual(Object.keys(profile.dataroom.domains), IDS);
  for (const id of IDS) {
    assert.equal(profile.dataroom.domains[id].folder, FOLDER[id]);
    assert.equal(profile.dataroom.domains[id].label, FOLDER[id], `${id}: no label of its own, so the folder's name`);
    assert.equal(profile.dataroom.domains[id].visible, true);
  }
  assert.equal(profile.dataroom.uploads_folder, FOLDER.uploads);
  assert.equal(new Set(folders.ROOT_FOLDERS).size, 8);
});
await check("the default profile's folders carry none of the former names that were record words", () => {
  assert.deepEqual(RENAMED, ["accounts", "deliveries", "projects"], "the three domains whose folder was a record word");
  const words = /customer|deployment|implementation|rollout/i;
  for (const id of [...IDS, "uploads"]) assert.doesNotMatch(FOLDER[id], words, `${id} is stored under "${FOLDER[id]}"`);
  for (const id of RENAMED) assert.match(FORMER[id], words, `${id}'s former folder was a record word`);
});
await check("the pin is the former name of every folder, and nothing else", () => {
  const pin = JSON.parse(readFileSync(PIN_FILE, "utf8"));
  assert.deepEqual(Object.keys(pin).filter((k) => !k.startsWith("$")), ["dataroom"]);
  assert.deepEqual(pin.dataroom.domains, Object.fromEntries(IDS.map((id) => [id, { folder: FORMER[id] }])));
  assert.equal(pin.dataroom.uploads_folder, FORMER.uploads);
});
await check("a profile with the pin stores every domain under its former name, and reads it under that name", () => {
  const { profile, err } = generate({ "50-pin.json": readFileSync(PIN_FILE, "utf8") });
  assert.ok(profile, err);
  for (const id of IDS) assert.deepEqual([profile.dataroom.domains[id].folder, profile.dataroom.domains[id].label], [FORMER[id], FORMER[id]]);
  assert.deepEqual(folders.foldersOf(profile), FORMER);
  assert.deepEqual(guard.unpinnedFormerFolders(folders.foldersOf(profile)), [], "nothing can be left behind");
});
await check("a profile may relabel a domain without moving it, by its id", () => {
  const { profile, err } = generate({ "50-x.json": room({ accounts: { label: "Companies" }, tickets: { visible: false } }) });
  assert.ok(profile, err);
  assert.deepEqual(profile.dataroom.domains.accounts, { folder: FOLDER.accounts, visible: true, label: "Companies" });
  assert.equal(profile.dataroom.domains.tickets.visible, false);
});
for (const id of RENAMED) {
  await check(`a profile that names ${id} by its former key and does not say where its files are is refused, with the line to add`, () => {
    const { status, err } = generate({ "50-old.json": room({ [FORMER[id]]: { label: "Something" } }) });
    assert.equal(status, 1);
    assert.match(err, new RegExp(`^profiles/50-old\\.json: dataroom\\.domains\\.${FORMER[id]}: `));
    assert.ok(err.includes(`"folder": "${FORMER[id]}"`) && err.includes(`{"dataroom": {"domains": {"${id}": {"folder": "${FORMER[id]}"}}}}`), err);
    assert.ok(err.includes(`"${FOLDER[id]}/"`) && err.includes("Nothing was built") && err.includes("left behind"), err);
    assert.ok(err.includes(`"folder": "${FOLDER[id]}"`), "and what to write for a deployment with no files yet");
  });
}
await check("…stating the folder beside the former key is accepted, and so is stating it in a later file by the domain's id", () => {
  const inline = generate({ "50-old.json": room(Object.fromEntries(RENAMED.map((id) => [FORMER[id], { folder: FORMER[id], label: `L ${id}` }]))) });
  assert.ok(inline.profile, inline.err);
  for (const id of RENAMED) assert.deepEqual([inline.profile.dataroom.domains[id].folder, inline.profile.dataroom.domains[id].label], [FORMER[id], `L ${id}`]);
  const later = generate({ "50-old.json": room(Object.fromEntries(RENAMED.map((id) => [FORMER[id], { label: `L ${id}` }]))), "51-pin.json": readFileSync(PIN_FILE, "utf8") });
  assert.ok(later.profile, later.err);
  assert.deepEqual(folders.foldersOf(later.profile), FORMER);
  // …and a deployment with no files yet says so the same way: the default name, stated.
  const fresh = generate({ "50-old.json": room(Object.fromEntries(RENAMED.map((id) => [FORMER[id], { folder: FOLDER[id] }]))) });
  assert.ok(fresh.profile, fresh.err);
  assert.deepEqual(folders.foldersOf(fresh.profile), { ...FOLDER });
});
await check("a former key whose folder never changed needs no pin", () => {
  const same = IDS.filter((id) => FOLDER[id] === FORMER[id]);
  assert.ok(same.length > 0);
  const { profile, err } = generate({ "50-old.json": room(Object.fromEntries(same.map((id) => [FORMER[id], { visible: false }]))) });
  assert.ok(profile, err);
  for (const id of same) assert.equal(profile.dataroom.domains[id].visible, false);
});
await check("one domain named twice, an unknown domain and a default that uses a former key are refused", () => {
  const id = RENAMED[0];
  assert.match(generate({ "50-x.json": room({ [FORMER[id]]: { folder: FORMER[id] }, [id]: { label: "X" } }) }).err, /are the same domain/);
  assert.match(generate({ "50-x.json": room({ Invoices: { label: "X" } }) }).err, /dataroom\.domains\.Invoices: not a data-room domain/);
});
await check("a folder must be one safe path segment, and no two domains share one", () => {
  for (const bad of ["a/b", "../x", "", " Accounts", "orgs", "_versions", "README.md", ".hidden", "x".repeat(70)]) {
    const r = generate({ "50-x.json": room({ accounts: { folder: bad } }) });
    assert.equal(r.status, 1, `${JSON.stringify(bad)} was accepted`);
    assert.match(r.err, /dataroom\.domains\.accounts\.folder: /);
  }
  assert.match(generate({ "50-x.json": room({ accounts: { folder: FOLDER.people } }) }).err, /Two domains cannot be stored in one folder/);
  assert.match(generate({ "50-x.json": room({}, { uploads_folder: FOLDER.tickets.toLowerCase() }) }).err, /Two domains cannot be stored in one folder/);
  assert.match(generate({ "50-x.json": room({ accounts: { label: FOLDER.people } }) }).err, /which is where people is stored/);
  assert.match(generate({ "50-x.json": room({ accounts: { colour: "red" } }) }).err, /dataroom\.domains\.accounts\.colour: unknown key/);
});
await check("a seeded path starts with one of the profile's own folders: the pinned name under the pin, never under the default", () => {
  const seed = [{ path: `${FORMER.accounts}/README.md`, content: "# x\n" }];
  assert.match(generate({ "50-x.json": room({}, { seed }) }).err, /does not start with one of this profile's data-room folders/);
  const pinned = generate({ "50-pin.json": readFileSync(PIN_FILE, "utf8"), "51-x.json": room({}, { seed }) });
  assert.ok(pinned.profile, pinned.err);
});
await check("the folders a generator reads without the profile being built are the same ones (scripts/lib/profile-folders.mjs)", () => {
  assert.deepEqual(storedFoldersOfTree(ROOT), { ...FOLDER });
});
await check("a folder placeholder is the stored name and a domain placeholder the label, for a reader outside the model's boundary", () => {
  assert.equal(folders.fillFolders("{folder:accounts}/{customer_id}/context.md in {domain:accounts}; ${folder:accounts} and {folder:nowhere} stay"), `${FOLDER.accounts}/{customer_id}/context.md in ${folders.labelOf("accounts")}; \${folder:accounts} and {folder:nowhere} stay`);
  assert.equal(folders.hasFolderPlaceholder("{folder:uploads}/x"), true);
  assert.ok(folders.pathPattern("accounts", "[^/]+/context\\.md").test(`${FOLDER.accounts}/acme/context.md`));
  assert.ok(!folders.pathPattern("accounts", "[^/]+/context\\.md").test(`x/${FOLDER.accounts}/acme/context.md`));
  assert.equal(folders.domainOfPath(`${FOLDER.deliveries}/acme/v1/x.md`), "deliveries");
  assert.equal(folders.domainIdOf(FOLDER.uploads), undefined, "the attached files' folder is not a domain");
  assert.equal(folders.folderIdOf(FOLDER.uploads), "uploads");
});

/* ---- the copies ---------------------------------------------------------------------------------------------------- */

/** A copy of this checkout (what git sees, plus node_modules by link), stamped with extra profiles and regenerated. */
function makeCopy(name, profiles) {
  const dir = tmp(`folders-${name}`);
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, "this test copies the checkout as git lists it");
  for (const f of listed.stdout.split("\0")) {
    if (!f || !existsSync(join(ROOT, f)) || statSync(join(ROOT, f)).isDirectory()) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  for (const [file, source] of profiles) cpSync(source, join(dir, "profiles", file));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const built = spawnSync("npm", ["run", "-s", "build:generated"], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(built.status, 0, `build:generated failed in the copy:\n${(built.stderr || built.stdout).slice(-2000)}`);
  return dir;
}
const runIn = (dir, args, env = {}) => spawnSync(process.execPath, [...NODE, ...args], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1", ...env } });
const firstDifference = (a, b) => {
  const x = a.split("\n"), y = b.split("\n");
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return `first difference at line ${i + 1}:\n  before: ${(x[i] ?? "<end>").slice(0, 220)}\n  now:    ${(y[i] ?? "<end>").slice(0, 220)}`;
};

/* ---- 2. the pin moves nothing --------------------------------------------------------------------------------------- */

console.log("\n2. A deployment that pins its folder names stores every file where it always did (a stamped copy)");
const pinned = makeCopy("pinned", [["50-legacy-folders.json", PIN_FILE]]);
await check("the copy is built with the pinned names, and has nothing the guard could find left behind", () => {
  const r = runIn(pinned, ["--input-type=module", "-e", `const f = await import("./agent/lib/dataroom-folders.ts"); const g = await import("./agent/lib/dataroom-folder-guard.ts"); console.log(JSON.stringify([f.FOLDER, g.UNPINNED_FORMER_FOLDERS]));`]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [FORMER, []]);
});
let pinnedCensus = null;
await check("the stored-path census is byte for byte the one taken before the folder names were a setting", () => {
  const r = runIn(pinned, ["scripts/lib/dataroom-path-census.mjs"]);
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const before = readFileSync(join(FIXTURES, "stored-paths-before.json"), "utf8");
  pinnedCensus = JSON.parse(r.stdout);
  assert.ok(r.stdout === before, firstDifference(before, r.stdout));
  // …and it is a census of something: every template was written, listed and read, and the tools ran.
  assert.equal(pinnedCensus.store.onDisk.length, pinnedCensus.grammar.templates.length);
  assert.deepEqual(pinnedCensus.store.listed, [...pinnedCensus.store.written].sort());
  assert.ok(pinnedCensus.tools.calls.length >= 25 && !JSON.stringify(pinnedCensus.seeders).includes('"failed"'));
});
await check("every door to the store (both drivers, the web routes, the root migration) passes, and asks for exactly the keys it asked for before", () => {
  const out = join(tmp("folders-keys"), "keys.json");
  const r = runIn(pinned, ["scripts/migrate-dataroom-root.mjs", "--self-test"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`.slice(-1500));
  const iso = runIn(pinned, ["--conditions=react-server", "scripts/test-dataroom-isolation.mjs"], { DATAROOM_KEY_CENSUS: out });
  assert.equal(iso.status, 0, `${iso.stdout}${iso.stderr}`.slice(-2500));
  const before = readFileSync(join(FIXTURES, "keys-before.json"), "utf8");
  const now = readFileSync(out, "utf8");
  assert.ok(now === before, firstDifference(before, now));
  assert.ok(JSON.parse(now).length > 40, "a census of something");
});
for (const [what, args] of [
  ["the store's own suite (path grammar, both write modes, listing)", ["scripts/test-dataroom-store.mjs"]],
  ["the sync landing zones", ["scripts/test-syncs.mjs"]],
  ["the workbook builder", ["scripts/test-workbook-spec.mjs"]],
  ["the system of record's document mirror", ["scripts/test-system-of-record.mjs"]],
  ["the PDF preview's path rules", ["scripts/test-pdf-preview.mjs"]],
  ["the fixture validator", ["scripts/validate-dataroom.mjs"]],
]) {
  await check(`${what} passes under the pin`, () => {
    const r = runIn(pinned, args);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`.slice(-2000));
  });
}
await check("the build-time check has nothing to look for under the pin, and does not open the store", () => {
  const r = runIn(pinned, ["scripts/check-dataroom-folders.mjs"], { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_none_none", DATAROOM_DIR: join(pinned, "no-such-room") });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stores every folder under the name the data room has always had/);
});

/* ---- 3. the default is the same tree under other names --------------------------------------------------------------- */

console.log("\n3. The default profile stores the same tree, under its own folder names");
await check("this checkout's census differs from the before-image in the first segment of a path, and in nothing else", () => {
  const r = runIn(ROOT, ["scripts/lib/dataroom-path-census.mjs"]);
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const now = JSON.parse(r.stdout);
  const before = JSON.parse(readFileSync(join(FIXTURES, "stored-paths-before.json"), "utf8"));
  // A stored name becomes this build's wherever it stands as one: a whole value, the head of a path, a path
  // segment after a workspace. File bodies are compared by path only: their text names the folders it describes.
  const former = new Map(Object.entries(FORMER).map(([id, name]) => [name, FOLDER[id]]));
  const renamed = (text) => text.replace(new RegExp(`(^|[^A-Za-z0-9_.-])(${[...former.keys()].join("|")})(?=$|[/"\\\\ ,.])`, "g"), (_m, lead, name) => `${lead}${former.get(name)}`);
  const paths = (c) => ({ ...c, store: { ...c.store, readBack: Object.keys(c.store.readBack) }, starter: c.starter.map(([p]) => p), seeders: { local: c.seeders.local.map(([p]) => p), blob: c.seeders.blob.map(([p]) => p) }, tools: { ...c.tools, calls: c.tools.calls.map((x) => ({ ...x, output: x.tool === "dataroom_read" ? { path: x.output.path } : x.output })) } });
  const sorted = (c) => JSON.parse(JSON.stringify(c, (_k, v) => (Array.isArray(v) && v.every((e) => typeof e === "string") ? [...v].sort() : v)));
  const want = JSON.stringify(sorted(JSON.parse(renamed(JSON.stringify(paths(before))))), null, 1);
  const got = JSON.stringify(sorted(paths(now)), null, 1);
  assert.ok(got === want, firstDifference(want, got));
  for (const id of RENAMED) assert.ok(!r.stdout.includes(`"${FORMER[id]}/`) && !r.stdout.includes(`"${FORMER[id]}"`), `the default census still names ${id} by its former folder`);
  assert.deepEqual(now.grammar.topLevelFolders, [...folders.ROOT_FOLDERS]);
});

/* ---- 4. the safety net ---------------------------------------------------------------------------------------------- */

console.log("\n4. A data room that holds a former folder the profile does not use is refused, never forked");
const candidates = guard.UNPINNED_FORMER_FOLDERS;
await check("this build could leave behind exactly the folders whose name changed", () => {
  assert.deepEqual(candidates.map((c) => [c.id, c.found, c.configured]), RENAMED.map((id) => [id, FORMER[id], FOLDER[id]]));
});
await check("the lines to add are valid JSON that the generator accepts, and with them nothing can be left behind", () => {
  const snippet = guard.pinSnippet(candidates);
  const { profile, err } = generate({ "60-dataroom-folders.json": snippet });
  assert.ok(profile, err);
  assert.deepEqual(guard.unpinnedFormerFolders(folders.foldersOf(profile)), []);
  for (const id of RENAMED) assert.equal(profile.dataroom.domains[id].folder, FORMER[id]);
});

const checkCli = (env) => spawnSync(process.execPath, [...NODE, "scripts/check-dataroom-folders.mjs"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, BLOB_READ_WRITE_TOKEN: "", ...env } });
const plant = (dir, files) => {
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "x\n");
  }
};
await check("the build check stops a build whose local data room holds a former folder, naming the workspace, the folder and the lines to add", () => {
  const dir = tmp("folders-room");
  plant(dir, [`orgs/acme-desk/${FORMER.accounts}/acme/context.md`, `orgs/acme-desk/${FOLDER.people}/sam/identity.json`, `orgs/new-desk/${FOLDER.accounts}/x/context.md`]);
  const r = checkCli({ DATAROOM_DIR: dir });
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes(`workspace "acme-desk": "${FORMER.accounts}/" (this build would use "${FOLDER.accounts}/")`), r.stderr);
  assert.ok(!r.stderr.includes('workspace "new-desk"'), "a workspace that only has this build's folders is not named");
  assert.ok(r.stderr.includes("Nothing was changed, and nothing will be moved") && r.stderr.includes("profiles/60-dataroom-folders.json"), r.stderr);
  const snippet = JSON.parse(r.stderr.split("\n").find((l) => l.trim().startsWith('{"dataroom"')).trim());
  assert.deepEqual(snippet, { dataroom: { domains: { accounts: { folder: FORMER.accounts } } } }, "only what was found is pinned");
});
await check("…and passes one that holds only this build's folders, an empty one, and none at all", () => {
  const dir = tmp("folders-room");
  plant(dir, [`orgs/new-desk/${FOLDER.accounts}/x/context.md`, `orgs/new-desk/${FOLDER.uploads}/p/a.pdf`]);
  const fine = checkCli({ DATAROOM_DIR: dir });
  assert.equal(fine.status, 0, fine.stderr);
  assert.match(fine.stdout, /holds no file under a folder name this profile does not use/);
  const empty = tmp("folders-room");
  mkdirSync(join(empty, "orgs", "a", FORMER.accounts), { recursive: true });
  assert.equal(checkCli({ DATAROOM_DIR: empty }).status, 0, "an empty folder holds no file");
  const none = checkCli({ DATAROOM_DIR: join(tmp("folders-room"), "missing") });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /no data room to look at from here/);
});
await check("…and can be told not to look, in so many words", () => {
  const dir = tmp("folders-room");
  plant(dir, [`orgs/acme-desk/${FORMER.projects}/acme/integromat.json`]);
  assert.equal(checkCli({ DATAROOM_DIR: dir }).status, 1);
  const skipped = checkCli({ DATAROOM_DIR: dir, DATAROOM_FOLDERS_CHECK: "skip" });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /skipped \(DATAROOM_FOLDERS_CHECK=skip\)\. Writes are still guarded at run time/);
});

// The blob driver and the web twin, against the real @vercel/blob client answered in memory.
const { installFakeBlob } = await imp("scripts/lib/fake-blob.mjs");
const blob = installFakeBlob();
const { blobStore, strandedWorkspaces, refusal } = await imp("scripts/check-dataroom-folders.mjs");
const store = await imp("agent/lib/dataroom-store.ts");
await check("the build check finds a former folder in the blob store, per workspace", async () => {
  blob.seed(`dataroom/orgs/old-desk/${FORMER.deliveries}/acme/v1/platform/organization.json`, "{}", 1000);
  blob.seed(`dataroom/orgs/old-desk/${FORMER.accounts}/acme/context.md`, "# a", 1000);
  blob.seed(`dataroom/orgs/new-desk/${FOLDER.accounts}/acme/context.md`, "# a", 1000);
  const found = await strandedWorkspaces(candidates, await blobStore(process.env.BLOB_READ_WRITE_TOKEN));
  assert.deepEqual(found.map((s) => [s.workspace, s.found.map((c) => c.found)]), [["old-desk", [FORMER.accounts, FORMER.deliveries]]]);
  const text = refusal("the Vercel Blob store", found, guard.pinSnippet(candidates));
  assert.ok(text.includes('workspace "old-desk"') && text.includes(guard.pinSnippet(candidates)));
});
const refusedWrite = async (write) => {
  try {
    await write();
    return null;
  } catch (error) {
    return error;
  }
};
await check("the agent's store refuses the first write into a workspace that holds a former folder (blob driver): nothing is written", async () => {
  const before = blob.keys().length;
  const old = store.createDataroomStore({ orgId: "old-desk" });
  const error = await refusedWrite(() => old.write(`${FOLDER.accounts}/acme/context.md`, "# new\n"));
  assert.ok(error instanceof guard.DataroomFoldersNotPinnedError, String(error));
  assert.ok(error.message.includes('The data room of workspace "old-desk" already holds files under') && error.message.includes(`"${FORMER.accounts}/" (this build would use "${FOLDER.accounts}/")`), error.message);
  assert.ok(error.message.includes("Nothing was written and nothing was moved") && error.message.includes(guard.pinSnippet(error.stranded)), error.message);
  assert.deepEqual(error.stranded.map((s) => s.id), ["accounts", "deliveries"], "what it found, nothing more");
  const again = await refusedWrite(() => old.appendJsonl(`${FOLDER.accounts}/acme/interactions.jsonl`, [{ n: 1 }]));
  assert.ok(again instanceof guard.DataroomFoldersNotPinnedError, "an append is a write");
  assert.equal(blob.keys().length, before, "no object was created");
  assert.equal(await old.read(`${FOLDER.accounts}/acme/context.md`), null, "a read is not refused; it finds nothing under the new name");
});
await check("…a workspace that only has this build's folders, and a new one, write as usual", async () => {
  const fresh = store.createDataroomStore({ orgId: "new-desk" });
  await fresh.write(`${FOLDER.accounts}/acme/context.md`, "# again\n");
  await store.createDataroomStore({ orgId: "brand-new" }).write(`${FOLDER.people}/sam/identity.json`, "{}\n");
  assert.ok(blob.keys().includes(`dataroom/orgs/brand-new/${FOLDER.people}/sam/identity.json`));
});
await check("…and the same on the local driver", async () => {
  const dir = tmp("folders-local");
  plant(dir, [`orgs/old-desk/${FORMER.projects}/acme/integromat.json`]);
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const old = store.createDataroomStore({ orgId: "old-desk", localRootDir: dir });
    const error = await refusedWrite(() => old.write(`${FOLDER.projects}/acme/integromat.json`, "{}\n"));
    assert.ok(error instanceof guard.DataroomFoldersNotPinnedError, String(error));
    assert.deepEqual(readdirSync(join(dir, "orgs", "old-desk")), [FORMER.projects], "no second folder was started");
    await store.createDataroomStore({ orgId: "new-desk", localRootDir: dir }).write(`${FOLDER.projects}/acme/integromat.json`, "{}\n");
    assert.ok(existsSync(join(dir, "orgs", "new-desk", FOLDER.projects, "acme", "integromat.json")));
  } finally {
    process.env.BLOB_READ_WRITE_TOKEN = token;
  }
});
await check("the web app's writer (uploads, a new workspace's starter files, version snapshots) refuses the same way", async () => {
  const web = await imp("lib/dataroom-blob.ts");
  guard.resetFolderGuard();
  const before = blob.keys().length;
  const error = await refusedWrite(() => web.writeDataroomFile(`${FOLDER.uploads}/sam/deck.pdf`, "x", "application/pdf", "old-desk"));
  assert.ok(error instanceof guard.DataroomFoldersNotPinnedError, String(error));
  assert.equal(blob.keys().length, before);
  await web.writeDataroomFile(`${FOLDER.uploads}/sam/deck.pdf`, "x", "application/pdf", "new-desk");
  assert.ok(blob.keys().includes(`dataroom/orgs/new-desk/${FOLDER.uploads}/sam/deck.pdf`));
});
await check("a look that fails is not taken for an answer: the write fails, and the next one looks again", async () => {
  guard.resetFolderGuard();
  let looks = 0;
  const failing = () => { looks++; return Promise.reject(new Error("store unreachable")); };
  await assert.rejects(guard.guardWorkspaceWrites("flaky", failing), /store unreachable/);
  const first = looks;
  await new Promise((r) => setTimeout(r, 0));
  await guard.guardWorkspaceWrites("flaky", async () => { looks++; return false; });
  assert.ok(looks > first, "it looked again");
  const settled = looks;
  await guard.guardWorkspaceWrites("flaky", async () => { looks++; return false; });
  assert.equal(looks, settled, "a clean answer is remembered for the process");
});

for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  x ${f}`);
  process.exit(1);
}
console.log("test-dataroom-folders: the folder names are the profile's; a pinned deployment stores every path where it always did; an unpinned one is refused, never forked");
process.exit(0);
