/**
 * ONE WORKSPACE'S DATA ROOM CANNOT SEE ANOTHER'S — every door to the file store, both drivers, driven for real.
 *
 * The principle: workspaces are not aware of each other. The data room broke it two ways (lib/dataroom-keyspace.ts):
 *
 *   (a) a MISSING workspace id fell back to the ROOT prefix `dataroom/` instead of being refused;
 *   (b) workspace #1 (`org-onfinance`, `org-onfinance-ai`) LIVED at that root, and the root contains `orgs/`, so its
 *       listing — and every search, zip and export built on a listing — returned every other workspace's files.
 *
 * Driven here, with no network and no token:
 *
 *   1. the agent's store (agent/lib/dataroom-store.ts) on the BLOB driver — the real `@vercel/blob` client answered
 *      by an in-memory store (scripts/lib/fake-blob.mjs);
 *   2. the same store on the LOCAL filesystem driver (`$DATAROOM_DIR/orgs/<id>`), which had the same nesting;
 *   3. the web app's twin (lib/dataroom-blob.ts) behind /api/dataroom, /api/ops/dataroom, export, upload, versions,
 *      the PDF preview and the workflow data reader — and the four LISTING doors driven as they run: the agent's
 *      dataroom_list tool, the /api/dataroom and /api/ops/dataroom?prefix=orgs route handlers (a real signed-in
 *      request), and the workflow data reader;
 *   4. the wiring of every other door (routes, versions, MCP server, agent package, artifacts) — source-level;
 *   5. the one-time move of the root (scripts/migrate-dataroom-root.mjs): dry run, apply, re-run, conflicts.
 *
 * It runs unchanged against `main`, which is how it was shown to fail there first.
 *
 *   npm run test:dataroom-isolation
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { FOLDER } from "../agent/lib/dataroom-folders.ts";

// The web app's `@/` alias and extensionless imports, so lib/dataroom-blob.ts loads as the app loads it.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) {
            try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
          }
          throw e;
        }
      }`),
  import.meta.url,
);

const { installFakeBlob } = await import("./lib/fake-blob.mjs");
const blob = installFakeBlob();

// DATAROOM_KEY_CENSUS=<file>: every object key and listing prefix that any door below asks the store for, written
// out when the run ends. scripts/test-dataroom-folders.mjs runs this file in a copy stamped with the folder pin and
// holds the result equal to its before-image: under the pin, every door addresses the keys it always did.
const keyCensus = new Set();
if (process.env.DATAROOM_KEY_CENSUS) {
  const push = blob.calls.push.bind(blob.calls);
  blob.calls.push = (...calls) => {
    for (const c of calls) keyCensus.add(`${c.op} ${c.pathname ?? c.prefix ?? ""}${c.from ? ` <- ${c.from}` : ""}`);
    return push(...calls);
  };
}

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
/** Resolves to { threw: true, message } or { threw: false, value }. */
const attempt = async (fn) => {
  try {
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, message: String(error?.message ?? error) };
  }
};
/** Source with comments stripped: these checks are about what the code DOES, and comments quote the old calls. */
const decomment = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const src = (path) => (existsSync(path) ? decomment(readFileSync(path, "utf8")) : "");

// Two ordinary workspaces (the live deployment's ids) and the legacy workspace #1 ids.
const A = "icici-hfc";
const B = "onfinance-ai";
const LEGACY = ["org-onfinance-ai", "org-onfinance"];
const A_FILES = [`${FOLDER.accounts}/acme-bank/context.md`, `${FOLDER.uploads}/priya-icici-com/board-pack.pdf`];
const A_JSONL = `${FOLDER.accounts}/acme-bank/interactions.jsonl`;
const LEG_FILE = `${FOLDER.accounts}/legacy-co/context.md`;

const store = await import("../agent/lib/dataroom-store.ts");

/* ---- 1 + 2. the agent's store, on each driver ------------------------------------------------------------------ */

async function storeSuite(driver, make) {
  console.log(`\n${driver === "blob" ? 1 : 2}. The agent's data-room store, ${driver} driver`);
  const a = make(A);
  const b = make(B);
  for (const path of A_FILES) await a.write(path, `A's ${path}\n`);
  await a.appendJsonl(A_JSONL, [{ interactionId: "INT-1", note: "A only" }]);

  const bList = await b.list("");
  check("workspace B lists none of A's files", !bList.some((p) => A_FILES.includes(p) || p === A_JSONL || p.includes(A)), bList);
  check(`…nor under a prefix (${FOLDER.accounts}/, ${FOLDER.uploads}/)`, (await b.list(FOLDER.accounts)).length === 0 && (await b.list(FOLDER.uploads)).length === 0);
  const bReads = await Promise.all([...A_FILES, A_JSONL].map((p) => b.read(p)));
  check("workspace B reads none of A's files at the same paths", bReads.every((v) => v === null), bReads);
  check("…nor their bytes", (await b.readBytes(A_FILES[1])) === null);
  check("…and a search (list + read) over B's whole tree finds nothing of A's", !(await Promise.all((await b.list("")).map((p) => b.read(p)))).some((t) => t?.includes("A's") || t?.includes("A only")));
  if (driver === "blob") {
    const url = await b.downloadUrl(A_FILES[1]);
    check("B's download link for that path names B's own key, never A's", url !== null && !url.includes(`/orgs/${A}/`) && url.includes(`/orgs/${B}/`), url);
  }

  for (const legacyId of LEGACY) {
    const leg = make(legacyId);
    await leg.write(LEG_FILE, "legacy workspace's own file\n");
    const all = await leg.list("");
    check(`legacy workspace ${legacyId} lists nothing under orgs/ (no other workspace's tree)`, !all.some((p) => p.startsWith("orgs/")), all);
    check(`…lists its own file`, all.includes(LEG_FILE), all);
    const nested = await attempt(() => leg.list("orgs"));
    check(`…and listing "orgs" from it yields nothing`, nested.threw || nested.value.length === 0, nested);
    const reachIn = await attempt(() => leg.read(`orgs/${A}/${A_FILES[0]}`));
    check(`…and cannot read A's file through orgs/${A}/…`, reachIn.threw || reachIn.value === null, reachIn);
  }

  const bare = await attempt(() => make(undefined).list(""));
  check("a store with NO workspace id refuses (throws) instead of reading the root", bare.threw, bare);
  for (const bad of [null, "", "  ", "../icici-hfc", "orgs/icici-hfc", "a/b"]) {
    const r = await attempt(async () => {
      const s = make(bad);
      await s.list("");
      return s;
    });
    check(`…and so does workspace id ${JSON.stringify(bad)}`, r.threw, r);
  }
}

await storeSuite("blob", (orgId) => store.createDataroomStore({ orgId }));
{
  const keys = blob.keys();
  check("every object the blob driver wrote is under dataroom/orgs/<workspace>/ — nothing at the root", keys.length > 0 && keys.every((k) => /^dataroom\/orgs\/[^/]+\//.test(k)), keys);
}
for (const [label, call] of [
  ["getDataroomStore() with no argument", () => store.getDataroomStore()],
  ["getDataroomStore(null)", () => store.getDataroomStore(null)],
  ["getDataroomStore(\"\")", () => store.getDataroomStore("")],
]) {
  const r = await attempt(async () => (await call()).list(""));
  check(`${label} refuses`, r.threw, r);
}

const localRoot = mkdtempSync(join(tmpdir(), "dataroom-iso-"));
{
  const savedToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await storeSuite("local", (orgId) => store.createDataroomStore({ orgId, localRootDir: localRoot }));
    const top = readdirSync(localRoot);
    check("every file the local driver wrote is under $DATAROOM_DIR/orgs/<workspace>/ — nothing at the root", top.length === 1 && top[0] === "orgs" && statSync(join(localRoot, "orgs")).isDirectory(), top);
  } finally {
    process.env.BLOB_READ_WRITE_TOKEN = savedToken;
    rmSync(localRoot, { recursive: true, force: true });
  }
}

/* ---- 3. the web app's twin ------------------------------------------------------------------------------------- */

console.log("\n3. The web app's data-room reader (lib/dataroom-blob.ts: /api/dataroom, /api/ops/dataroom, export, upload)");
{
  const web = await import("../lib/dataroom-blob.ts");
  const bPaths = await web.listDataroomPaths(B);
  check("workspace B's listing has none of A's files", !bPaths.some((p) => A_FILES.includes(p) || p.includes(A)), bPaths);
  for (const legacyId of LEGACY) {
    const paths = await web.listDataroomPaths(legacyId);
    check(`legacy workspace ${legacyId}'s listing has nothing under orgs/`, !paths.some((p) => p.startsWith("orgs/")), paths);
  }
  check("B reads nothing at A's path", (await web.readDataroomFile(A_FILES[0], B)) === null);
  check("B stats nothing at A's path (the PDF preview's size check)", (await web.statDataroomObject(A_FILES[1], B)) === null);
  check("B opens nothing at A's path (the PDF preview's bytes)", (await web.openDataroomObject(A_FILES[1], B)) === null);
  const noOrg = [
    ["listDataroomPaths()", () => web.listDataroomPaths()],
    ["readDataroomFile(path) — the export route's call", () => web.readDataroomFile(A_FILES[0])],
    ["writeDataroomFile(path, body) — an upload", () => web.writeDataroomFile(`${FOLDER.uploads}/x/y.txt`, "y")],
    ["statDataroomObject(path)", () => web.statDataroomObject(A_FILES[1])],
    ["openDataroomObject(path)", () => web.openDataroomObject(A_FILES[1])],
  ];
  const before = blob.keys().length;
  for (const [label, call] of noOrg) {
    const r = await attempt(call);
    check(`${label} with no workspace refuses (throws)`, r.threw, r);
  }
  check("…and none of them wrote anything", blob.keys().length === before && !blob.keys().includes(`dataroom/${FOLDER.uploads}/x/y.txt`));
}

/* ---- 3b. the four listing doors, driven for real ---------------------------------------------------------------- */

// The review named four doors through which the legacy root revealed other workspaces' company ids: the agent's
// `dataroom_list` tool, GET /api/dataroom, GET /api/ops/dataroom?prefix=orgs, and the workflow data reader. Each is
// driven here as it runs: the real tool, the real route handlers (a real signed-in request), the real reader. No
// database, so every caller resolves to the default workspace — `org-onfinance`, one of the ids that WAS the root.
console.log("\n3b. The four listing doors (dataroom_list, /api/dataroom, /api/ops/dataroom?prefix=orgs, workflow data)");
{
  const { generateKeyPairSync } = await import("node:crypto");
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
  process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  const leaks = (paths) => (paths ?? []).filter((p) => String(p).startsWith("orgs/") || String(p).includes(A) || A_FILES.includes(p));
  const { mintSessionToken } = await import("../lib/auth-session.ts");
  const bearer = `Bearer ${await mintSessionToken("reader@onfinance.in")}`;
  const { NextRequest } = await import("next/server");
  const call = async (mod, url) => {
    const route = await import(mod);
    const res = await route.GET(new NextRequest(url, { headers: { authorization: bearer } }));
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const tools = await import("../agent/lib/dataroom-tools.ts");
  const ctx = { session: { id: "iso-probe", auth: { current: null, initiator: null } } };
  for (const prefix of ["", "orgs"]) {
    const r = await attempt(() => tools.dataroomListTool.execute(prefix ? { prefix } : {}, ctx));
    const paths = r.threw ? [] : (r.value.paths ?? []);
    check(`dataroom_list ${prefix ? `(prefix "${prefix}") ` : ""}returns no other workspace's path`, !r.threw && leaks(paths).length === 0, r.threw ? r : leaks(paths));
  }

  const dr = await call("../app/api/dataroom/route.ts", "http://iso.test/api/dataroom");
  check("GET /api/dataroom answers (200)", dr.status === 200, dr);
  check("…and lists no other workspace's path", leaks(dr.body?.paths).length === 0, leaks(dr.body?.paths));
  for (const prefix of ["", "orgs", `orgs/${A}`]) {
    const ops = await call("../app/api/ops/dataroom/route.ts", `http://iso.test/api/ops/dataroom${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`);
    check(`GET /api/ops/dataroom${prefix ? `?prefix=${prefix}` : ""} lists no other workspace's path`, ops.status === 200 && leaks(ops.body?.paths).length === 0, { status: ops.status, leaks: leaks(ops.body?.paths) });
  }

  const { workflowDataFor } = await import("../lib/workflow-data.ts");
  for (const org of ["org-onfinance", "org-onfinance-ai"]) {
    for (const prefix of ["", "orgs"]) {
      const r = await attempt(() => workflowDataFor(org).dataroomList(prefix));
      check(`workflow data (${org}${prefix ? `, prefix "${prefix}"` : ""}) lists no other workspace's path`, !r.threw && leaks(r.value).length === 0, r.threw ? r : leaks(r.value));
    }
    const read = await attempt(() => workflowDataFor(org).dataroomRead(`orgs/${A}/${A_FILES[0]}`));
    check(`workflow data (${org}) reads nothing of A's through orgs/${A}/…`, !read.threw && read.value === null, read);
  }
}

/* ---- 4. every other door, by its wiring ------------------------------------------------------------------------ */

console.log("\n4. Every other door to the file store is bound to the caller's workspace");
{
  const everywhere = ["agent", "lib", "app", "setup", "scripts/lib"]
    .flatMap(function walk(dir) {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).flatMap((f) => {
        const full = `${dir}/${f}`;
        if (f === "node_modules" || f.startsWith(".")) return [];
        return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|mjs)$/.test(f) ? [full] : [];
      });
    })
    .filter((f) => !f.endsWith(".generated.ts"));
  const offenders = (re) => everywhere.filter((f) => re.test(src(f)));
  check("no LEGACY_ROOT_ORGS mapping remains anywhere (no workspace lives at the root)", offenders(/LEGACY_ROOT_ORGS?\b/).length === 0, offenders(/LEGACY_ROOT_ORGS?\b/));
  check("no bare getDataroomStore() / getDataroomStore(null) / createDataroomStore() in app code", offenders(/getDataroomStore\(\s*(null)?\s*\)|createDataroomStore\(\s*\)/).length === 0, offenders(/getDataroomStore\(\s*(null)?\s*\)|createDataroomStore\(\s*\)/));
  check("no web data-room call passes a null workspace (the version snapshots did)", offenders(/(read|write)DataroomFile\([^;]*,\s*null\s*\)/).length === 0, offenders(/(read|write)DataroomFile\([^;]*,\s*null\s*\)/));
  const exportRoute = src("app/api/ops/export/route.ts");
  check("the export route reads the data room in the caller's workspace", /readDataroomFile\(\s*path\s*,\s*\w+/.test(exportRoute) && !/readDataroomFile\(\s*path\s*\)/.test(exportRoute));
  const upload = src("app/api/ops/upload/route.ts");
  check("the upload route never writes without a workspace (no `org?.orgId` write)", !/writeDataroomFile\([^)]*org\?\.orgId/.test(upload) && /if \(!org\?\.orgId\)/.test(upload));
  const versions = src("agent/lib/dataroom-versions.ts");
  check("the agent's version snapshots are written in the workspace's own tree", !/getDataroomStore\(null\)/.test(versions));
  const mcp = src("setup/workspace-mcp.mjs");
  check("the MCP server's store needs the selected workspace (no `?? undefined` fallback to the root)", /createDataroomStore\(\{\s*orgId:/.test(mcp) && !/orgId:\s*OPS_ORG\s*\?\?\s*undefined/.test(mcp));
  const seed = src("scripts/seed-dataroom-blob.mjs");
  check("the blob seed script names its workspace", !/getDataroomStore\(\s*\)/.test(seed));
  const artifact = src("agent/lib/artifact.ts");
  const artifactLink = src("app/api/ops/artifact-link/route.ts");
  check("a published artifact is filed under its workspace (artifacts/orgs/<id>/…)", /artifacts\/orgs\//.test(artifact) || /artifactKey\(/.test(artifact));
  check("the artifact link refuses another workspace's artifact", /(artifacts\/|ARTIFACT_PREFIX\})orgs\/\$\{ctx\.orgId\}\//.test(artifactLink));
}

/* ---- 5. the one-time move of the root -------------------------------------------------------------------------- */

console.log("\n5. The root's objects move only where they are PROVEN to belong (scripts/migrate-dataroom-root.mjs)");
{
  const script = "scripts/migrate-dataroom-root.mjs";
  if (!existsSync(script)) {
    check(`${script} exists`, false);
  } else {
    const { migrateDataroomRoot, blobDriver } = await import(`../${script}`);
    const quiet = () => {};
    const LIVE = "onfinance-ai";
    const seedRoot = () => {
      blob.reset();
      // On the live deployment NEITHER workspace used the root: it holds what callers that named no workspace wrote,
      // from either workspace, plus seed and probe files. So nothing may move on a guess.
      blob.seed(`dataroom/${FOLDER.accounts}/acme-bank/context.md`, "# acme, written with no workspace\n", 1000);
      blob.seed(`dataroom/${FOLDER.tickets}/bug/acme-bank/v1/tickets_TCK-1.jsonl`, '{"t":1}\n', 1000);
      blob.seed(`dataroom/${FOLDER.accounts}/shared-co/context.md`, "# held by both\n", 1000);
      blob.seed(`dataroom/${FOLDER.accounts}/ghost-co/context.md`, "# held by nobody\n", 1000);
      blob.seed(`dataroom/${FOLDER.accounts}/surface-probe-co/context.md`, "# probe\n", 1000);
      blob.seed(`dataroom/${FOLDER.people}/sam-example-com/identity.json`, "{}\n", 1000);
      blob.seed(`dataroom/_versions/${A}/1700000000000-${FOLDER.accounts}/x/context.md`, "# A's snapshot\n", 1000);
      // The reviewer's reproduction: the same size, a NEWER destination, DIFFERENT bytes.
      blob.seed(`dataroom/${FOLDER.uploads}/sam-example-com/deck.pdf`, "ROOT-A\n", 1000);
      blob.seed(`dataroom/orgs/${LIVE}/${FOLDER.uploads}/sam-example-com/deck.pdf`, "LIVE-B\n", 2000);
      // …and a destination that really is the same object (a copy an earlier run made).
      blob.seed(`dataroom/${FOLDER.uploads}/sam-example-com/notes.md`, "same bytes\n", 1000);
      blob.seed(`dataroom/orgs/${LIVE}/${FOLDER.uploads}/sam-example-com/notes.md`, "same bytes\n", 2000);
    };
    // Which workspaces hold each company id (read-only from each workspace's customers table in production).
    const companyOwners = new Map([
      ["acme-bank", new Set([A])],
      ["shared-co", new Set([A, LIVE])],
    ]);
    // A run that throws is reported as a failed check below, not a crash (so the whole matrix runs on `main`).
    const run = (opts) =>
      migrateDataroomRoot({ driver: blobDriver(), companyOwners, log: quiet, ...opts }).catch((e) => ({ error: String(e?.message ?? e) }));
    const where = (p) => blob.objects.get(p)?.body.toString();

    seedRoot();
    const before = new Map([...blob.objects].map(([k, v]) => [k, v.body.toString()]));
    const dry = await run({ to: LIVE, json: true });
    check("the dry run changes nothing", blob.objects.size === before.size && [...before].every(([k, v]) => where(k) === v));
    const planned = (p) => (dry.objects ?? []).find((o) => o.pathname === p);
    check("the dry run lists EVERY root object with what would happen to it", Array.isArray(dry.objects) && dry.objects.filter((o) => !o.pathname.startsWith("orgs/")).length === 9, dry.objects);
    check("a company path goes to the ONE workspace whose customers table holds it — not to --to", planned(`${FOLDER.accounts}/acme-bank/context.md`)?.to === `orgs/${A}/${FOLDER.accounts}/acme-bank/context.md` && planned(`${FOLDER.tickets}/bug/acme-bank/v1/tickets_TCK-1.jsonl`)?.to === `orgs/${A}/${FOLDER.tickets}/bug/acme-bank/v1/tickets_TCK-1.jsonl`, [planned(`${FOLDER.accounts}/acme-bank/context.md`), planned(`${FOLDER.tickets}/bug/acme-bank/v1/tickets_TCK-1.jsonl`)]);
    check("a company held by BOTH workspaces is ambiguous and stays", planned(`${FOLDER.accounts}/shared-co/context.md`)?.action === "ambiguous", planned(`${FOLDER.accounts}/shared-co/context.md`));
    check("a company held by NEITHER is ambiguous and stays", planned(`${FOLDER.accounts}/ghost-co/context.md`)?.action === "ambiguous", planned(`${FOLDER.accounts}/ghost-co/context.md`));
    check(`anything not attributable and not named explicitly stays (${FOLDER.people}/, ${FOLDER.uploads}/), whatever --to says`, [`${FOLDER.people}/sam-example-com/identity.json`, `${FOLDER.uploads}/sam-example-com/deck.pdf`, `${FOLDER.uploads}/sam-example-com/notes.md`].every((p) => planned(p)?.action === "stay"), [`${FOLDER.people}/sam-example-com/identity.json`, `${FOLDER.uploads}/sam-example-com/deck.pdf`].map(planned));
    check("a snapshot goes to its own workspace", planned(`_versions/${A}/1700000000000-${FOLDER.accounts}/x/context.md`)?.to === `orgs/${A}/_versions/${A}/1700000000000-${FOLDER.accounts}/x/context.md`);

    const applied = await run({ to: LIVE, apply: true });
    check("applying moves only the attributed objects", applied.applied?.moved === 3 && applied.applied?.failed === 0, applied.applied);
    check("…acme-bank's files are in ITS workspace", where(`dataroom/orgs/${A}/${FOLDER.accounts}/acme-bank/context.md`) === "# acme, written with no workspace\n" && !blob.objects.has(`dataroom/${FOLDER.accounts}/acme-bank/context.md`) && !blob.objects.has(`dataroom/orgs/${LIVE}/${FOLDER.accounts}/acme-bank/context.md`));
    check("…and nothing unattributed moved to --to", [`${FOLDER.accounts}/shared-co/context.md`, `${FOLDER.accounts}/ghost-co/context.md`, `${FOLDER.people}/sam-example-com/identity.json`, `${FOLDER.uploads}/sam-example-com/deck.pdf`].every((p) => blob.objects.has(`dataroom/${p}`)));

    const named = await run({ to: LIVE, only: [`${FOLDER.uploads}/`], apply: true });
    check("REVIEWER'S BLOCKER: same size, newer destination, different bytes is a CONFLICT — the root copy is kept", where(`dataroom/${FOLDER.uploads}/sam-example-com/deck.pdf`) === "ROOT-A\n" && where(`dataroom/orgs/${LIVE}/${FOLDER.uploads}/sam-example-com/deck.pdf`) === "LIVE-B\n", named.conflicts);
    check("…reported as a conflict", (named.conflicts ?? []).some((c) => c.from === `${FOLDER.uploads}/sam-example-com/deck.pdf`), named.conflicts);
    check("a destination with the SAME bytes is done: the root copy is removed", !blob.objects.has(`dataroom/${FOLDER.uploads}/sam-example-com/notes.md`) && where(`dataroom/orgs/${LIVE}/${FOLDER.uploads}/sam-example-com/notes.md`) === "same bytes\n");
    check("--only moves nothing outside its prefix", blob.objects.has(`dataroom/${FOLDER.people}/sam-example-com/identity.json`));

    await run({ to: LIVE, moveFiles: [`${FOLDER.people}/sam-example-com/identity.json`], apply: true });
    check("--move-file moves exactly the named object to --to", where(`dataroom/orgs/${LIVE}/${FOLDER.people}/sam-example-com/identity.json`) === "{}\n" && !blob.objects.has(`dataroom/${FOLDER.people}/sam-example-com/identity.json`));
    await run({ to: LIVE, moveFiles: [`${FOLDER.accounts}/shared-co/context.md`], apply: true });
    check("…but never a company path attributed to both workspaces", blob.objects.has(`dataroom/${FOLDER.accounts}/shared-co/context.md`));

    const delDry = await run({ deleteUnowned: [`${FOLDER.accounts}/surface-probe-co`] });
    check("--delete-unowned lists what it would delete on a dry run, and deletes nothing", (delDry.objects ?? []).some((o) => o.pathname === `${FOLDER.accounts}/surface-probe-co/context.md` && o.action === "delete") && blob.objects.has(`dataroom/${FOLDER.accounts}/surface-probe-co/context.md`));
    await run({ deleteUnowned: [`${FOLDER.accounts}/surface-probe-co`, `${FOLDER.accounts}/acme-bank`], apply: true });
    check("…and on --apply deletes the unowned objects under it only", !blob.objects.has(`dataroom/${FOLDER.accounts}/surface-probe-co/context.md`) && where(`dataroom/orgs/${A}/${FOLDER.accounts}/acme-bank/context.md`) !== undefined);

    const again = await run({ to: LIVE, only: [`${FOLDER.uploads}/`], apply: true });
    check("re-running is idempotent: nothing moves, the conflict is still reported", again.applied?.moved === 0 && again.counts?.conflict === 1, again.counts);
    const a = store.createDataroomStore({ orgId: A });
    check("workspace A reads the moved files at its own prefix", (await a.read(`${FOLDER.accounts}/acme-bank/context.md`)) === "# acme, written with no workspace\n");
    const refusedNoTarget = await attempt(() => migrateDataroomRoot({ driver: blobDriver(), companyOwners, log: quiet, to: "", moveFiles: [`${FOLDER.people}/x`], apply: false }));
    check("naming objects without a target workspace is refused", refusedNoTarget.threw, refusedNoTarget);
  }
}

/* ---- 6. small doors (review of #85) ------------------------------------------------------------------------------ */

console.log("\n6. Snapshot keys and artifact links cannot be bent into another workspace's");
{
  const keyspace = await import("../lib/dataroom-keyspace.ts");
  for (const key of [`_versions/${A}/%2e%2e/${B}/1-x.md`, `_versions/${A}/%2E%2E/x`, `_versions/${A}/1-a%2fb`]) {
    const r = await attempt(() => keyspace.isOwnSnapshotKey(A, key));
    check(`a percent-encoded snapshot key is refused: ${key}`, !r.threw && r.value === false, r);
  }
  const { mintSessionToken } = await import("../lib/auth-session.ts");
  const { NextRequest } = await import("next/server");
  const link = await import("../app/api/ops/artifact-link/route.ts");
  const bearer = `Bearer ${await mintSessionToken("reader@onfinance.in")}`;
  blob.seed(`artifacts/orgs/${A}/secret-report.html`, "<p>A's</p>", 1000);
  for (const path of [`artifacts//orgs/${A}/secret-report.html`, `artifacts/./orgs/${A}/secret-report.html`, `artifacts/orgs//${A}/secret-report.html`]) {
    const res = await link.GET(new NextRequest(`http://iso.test/api/ops/artifact-link?path=${encodeURIComponent(path)}`, { headers: { authorization: bearer } }));
    check(`the artifact link refuses ${path} from another workspace (no signed URL)`, res.status >= 400, res.status);
  }
}

if (process.env.DATAROOM_KEY_CENSUS) {
  // A snapshot's timestamp and an append part's stamp differ on every run; the path they belong to does not.
  const stable = (k) => k.replace(/(_versions\/[^/]+\/)\d+-/g, "$1<at>-").replace(/\.appends\/[0-9]+-[0-9]+-[0-9a-f]+\.part/g, ".appends/<part>");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.DATAROOM_KEY_CENSUS, `${JSON.stringify([...new Set([...keyCensus].map(stable))].sort(), null, 2)}\n`);
}
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
