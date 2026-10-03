#!/usr/bin/env node
/**
 * TWO SIGNED-IN WORKSPACES, ONE DIRECTORY ON DISK — the filesystem storage driver over HTTP, against `next start` of
 * a real build, as the restricted app_rw role.
 *
 * On Vercel Blob a workspace's files are the objects under `dataroom/orgs/<id>/`, and the only way to one is a route
 * that takes the workspace from the verified caller. With `STORAGE_DRIVER=filesystem` the same keys are paths under
 * one directory, and a path is a thing people have been climbing out of for fifty years. This drives the real server
 * as two real members, Alice of workspace A and Bob of workspace B, and reads the disk directly to see what happened:
 *
 *   1. each writes and uploads; every file lands under objects/dataroom/orgs/<their workspace>/ and nowhere else;
 *   2. Bob cannot LIST anything of A's (no path, no prefix, no `orgs/…` prefix);
 *   3. Bob cannot READ A's files: the same path is his own (empty) tree, and every way of spelling A's tree in a path
 *      (`orgs/<A>/…`, `../<A>/…`, percent-encoded, a snapshot key) is refused, for text and for bytes;
 *   4. Bob cannot OVERWRITE A's files: a write at the same path creates Bob's file, and A's bytes on disk are unchanged;
 *   5. naming A's workspace on the request is refused, as on every driver;
 *   6. artifacts: Bob gets no link for A's artifact; Alice does; the link serves the bytes sandboxed, the proxy follows
 *      it, and a tampered, unsigned, re-pointed or expired link is refused. There is no listing and no unsigned read
 *      of anything under the storage directory;
 *   7. the health check probes this driver and leaves nothing behind.
 *
 * Before the storage driver this fails at step 1: STORAGE_DRIVER is ignored, no token is set, and every route answers
 * "storage is not configured".
 *
 * Needs a production build in --dir (default: this checkout), ADMIN_URL (seeding) and DATABASE_URL (app_rw). Without
 * the URLs it skips. Rows live under throwaway workspaces carrying this process's pid, removed in a finally block;
 * the storage directory is a temp directory, removed too.
 *
 *   ADMIN_URL=… DATABASE_URL=… npm run test:storage-isolation-http-db [-- --dir <built checkout>]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { freePort, waitForNextStart } from "./lib/own-listener.mjs";

const adminUrl = process.env.ADMIN_URL;
const url = process.env.DATABASE_URL;
if (!adminUrl || !url) {
  console.log("test-storage-isolation-http-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (the app_rw url).");
  process.exit(0);
}
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIR = process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : ROOT;
if (!existsSync(join(DIR, ".next", "BUILD_ID"))) {
  console.error(`test-storage-isolation-http-db: no production build in ${DIR}/.next — run \`npm run build\` first.`);
  process.exit(2);
}

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
  }
};

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const admin = postgres(adminUrl, { ssl: local ? false : "require", prepare: false, max: 1, onnotice: () => {} });
const PID = process.pid;
const A = `org-store-a-${PID}`;
const B = `org-store-b-${PID}`;
const ALICE = `alice-${PID}@store-a.test`;
const BOB = `bob-${PID}@store-b.test`;
const slug = (email) => email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const STORE = mkdtempSync(join(tmpdir(), "storage-http-"));
const SECRET = `http-test-secret-${PID}-0123456789abcdef0123456789`;
const filesUnder = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
        .sort();
const onDisk = () => filesUnder(join(STORE, "objects"));
const diskText = (key) => (existsSync(join(STORE, "objects", key)) ? readFileSync(join(STORE, "objects", key), "utf8") : null);

async function unseed() {
  for (const t of ["dataroom_file_versions", "dataroom_changesets", "automation_audit", "entity_activity", "org_members"]) {
    await admin.unsafe(`delete from ${t} where org_id in ($1, $2)`, [A, B]).catch(() => {});
  }
  await admin`delete from orgs where org_id in (${A}, ${B})`.catch(() => {});
}

const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(publicKey);
const { mintSessionToken } = await import("../lib/auth-session.ts");
/** The deployment's stored folder names (agent/lib/dataroom-folders.ts): paths are built from them. */
const { FOLDER: F } = await import("../agent/lib/dataroom-folders.ts");
const tokens = { [ALICE]: await mintSessionToken(ALICE), [BOB]: await mintSessionToken(BOB) };

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const storageEnv = { STORAGE_DRIVER: "filesystem", STORAGE_FS_ROOT: STORE, STORAGE_SIGNING_SECRET: SECRET, STORAGE_PUBLIC_URL: base };
let server;
let log = "";
async function start() {
  const env = { ...process.env, ...storageEnv, DATABASE_URL: url, AUTH_JWT_PUBLIC_KEY: process.env.AUTH_JWT_PUBLIC_KEY, AUTH_JWT_PRIVATE_KEY: "", NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) };
  delete env.BLOB_READ_WRITE_TOKEN;
  server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: DIR, stdio: ["ignore", "pipe", "pipe"], env });
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  await waitForNextStart({ server, port, log: () => log });
}
const call = async (who, method, path, { json, form, org } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(org ? { "x-ops-org": org } : {}),
    },
    body: json !== undefined ? JSON.stringify(json) : form,
    redirect: "manual",
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, body, text, headers: res.headers };
};
const upload = (who, name, content) => {
  const form = new FormData();
  form.set("file", new File([Buffer.from(content)], name, { type: "application/pdf" }));
  return call(who, "POST", "/api/ops/upload", { form });
};

const CONTEXT = `${F.accounts}/acme-bank/context.md`;
const A_PDF = `${F.uploads}/${slug(ALICE)}/board-pack.pdf`;
const keyOf = (org, path) => `dataroom/orgs/${org}/${path}`;

try {
  await unseed();
  await admin`insert into orgs (org_id, name, status) values (${A}, 'Storage desk A', 'active'), (${B}, 'Storage desk B', 'active')`;
  await admin`insert into org_members (org_id, email, role, accepted_at) values (${A}, ${ALICE}, 'member', now()), (${B}, ${BOB}, 'member', now())`;
  await start();

  console.log("1. Each workspace writes; the files land in its own tree");
  const aWrite = await call(ALICE, "POST", "/api/ops/dataroom", { json: { path: CONTEXT, content: "A's context: confidential to workspace A\n" } });
  check("Alice writes a file (200)", aWrite.status === 200, aWrite);
  const aUp = await upload(ALICE, "board-pack.pdf", "%PDF-1.7 A's board pack");
  check("Alice uploads a file (200)", aUp.status === 200 && aUp.body?.path === A_PDF, aUp.body ?? aUp.text.slice(0, 200));
  const bUp = await upload(BOB, "notes.pdf", "%PDF-1.7 B's notes");
  check("Bob uploads a file (200)", bUp.status === 200, bUp.body ?? bUp.text.slice(0, 200));
  check("on disk: A's files are under objects/dataroom/orgs/<A>/", diskText(keyOf(A, CONTEXT)) === "A's context: confidential to workspace A\n" && diskText(keyOf(A, A_PDF)) === "%PDF-1.7 A's board pack", onDisk());
  check("on disk: every object is under dataroom/orgs/<A or B>/", onDisk().length === 3 && onDisk().every((k) => k.startsWith(`dataroom/orgs/${A}/`) || k.startsWith(`dataroom/orgs/${B}/`)), onDisk());
  check("the storage directory holds only objects/, meta/ and tmp/", readdirSync(STORE).every((d) => ["objects", "meta", "tmp"].includes(d)), readdirSync(STORE));

  console.log("\n2. Bob cannot list anything of A's");
  const leaks = (r) => [A, "A's context", "board-pack", slug(ALICE)].filter((s) => r.text.includes(s));
  for (const path of ["/api/dataroom", "/api/ops/dataroom", "/api/ops/dataroom?prefix=orgs", `/api/ops/dataroom?prefix=${encodeURIComponent(`orgs/${A}`)}`, `/api/ops/dataroom?prefix=${F.accounts}`, `/api/ops/dataroom?prefix=${encodeURIComponent(`../${A}`)}`, `/api/ops/dataroom?prefix=${F.uploads}`]) {
    const r = await call(BOB, "GET", path);
    check(`GET ${path} as Bob shows nothing of A's`, r.status === 200 && Array.isArray(r.body?.paths) && leaks(r).length === 0, { status: r.status, leaks: leaks(r), body: r.text.slice(0, 200) });
  }
  const aList = await call(ALICE, "GET", "/api/dataroom");
  check("…while Alice lists exactly her two files", aList.status === 200 && JSON.stringify(aList.body.paths) === JSON.stringify([CONTEXT, A_PDF].sort()), aList.body);

  console.log("\n3. Bob cannot read A's files");
  const same = await call(BOB, "GET", `/api/dataroom?path=${encodeURIComponent(CONTEXT)}`);
  check("the same path, as Bob, is his own tree: not found", same.status === 200 && same.body?.found === false && leaks(same).length === 0, same.body);
  const sameBytes = await call(BOB, "GET", `/api/dataroom?path=${encodeURIComponent(A_PDF)}&as=bytes`);
  check("…and its bytes are not found (404)", sameBytes.status === 404 && leaks(sameBytes).length === 0, sameBytes.text.slice(0, 200));
  const REACH = [`orgs/${A}/${CONTEXT}`, `../${A}/${CONTEXT}`, `${F.accounts}/../../${A}/${CONTEXT}`, `${F.accounts}/%2e%2e/%2e%2e/${A}/${CONTEXT}`, `/${CONTEXT}`, `${F.accounts}\\..\\..\\${A}\\${CONTEXT}`, `_versions/${A}/1-${CONTEXT}`, `${F.uploads}/../../${A}/${A_PDF}`];
  for (const reach of REACH) {
    const q = encodeURIComponent(reach);
    const reads = [await call(BOB, "GET", `/api/dataroom?path=${q}`), await call(BOB, "GET", `/api/dataroom?path=${q}&as=bytes`), await call(BOB, "GET", `/api/ops/dataroom?path=${q}`)];
    check(`reading ${JSON.stringify(reach)} as Bob is refused (400) and shows nothing`, reads.every((r) => r.status === 400 && leaks(r).length === 0), reads.map((r) => r.status));
  }

  console.log("\n4. Bob cannot overwrite A's files");
  const before = onDisk();
  for (const reach of REACH) {
    const w = await call(BOB, "POST", "/api/ops/dataroom", { json: { path: reach, content: "pwned by Bob\n" } });
    check(`writing ${JSON.stringify(reach)} as Bob is refused (400)`, w.status === 400, w.status);
  }
  check("…nothing was created, and A's bytes are unchanged", JSON.stringify(onDisk()) === JSON.stringify(before) && diskText(keyOf(A, CONTEXT)) === "A's context: confidential to workspace A\n");
  const bWrite = await call(BOB, "POST", "/api/ops/dataroom", { json: { path: CONTEXT, content: "B's own context\n" } });
  check("a write at the SAME path as Bob creates Bob's file", bWrite.status === 200 && diskText(keyOf(B, CONTEXT)) === "B's own context\n", bWrite);
  check("…and A's file on disk is still A's", diskText(keyOf(A, CONTEXT)) === "A's context: confidential to workspace A\n");
  const bAppend = await call(BOB, "POST", "/api/ops/dataroom", { json: { path: `${F.accounts}/acme-bank/interactions.jsonl`, content: '{"by":"bob"}', append: true } });
  check("…an append as Bob lands in Bob's tree only", bAppend.status === 200 && onDisk().some((k) => k.startsWith(`dataroom/orgs/${B}/${F.accounts}/acme-bank/interactions.jsonl`)) && !onDisk().some((k) => k.startsWith(`dataroom/orgs/${A}/${F.accounts}/acme-bank/interactions.jsonl`)), onDisk());
  const bUpSame = await upload(BOB, "../../board-pack.pdf", "%PDF-1.7 Bob's upload with a climbing name");
  check(`…an upload whose name climbs lands in Bob's own ${F.uploads} folder; A's upload is unchanged`, bUpSame.status === 200 && bUpSame.body.path === `${F.uploads}/${slug(BOB)}/board-pack.pdf` && diskText(keyOf(A, A_PDF)) === "%PDF-1.7 A's board pack", bUpSame.body);
  const aAfter = await call(ALICE, "GET", `/api/dataroom?path=${encodeURIComponent(CONTEXT)}`);
  check("Alice still reads her own content", aAfter.body?.content === "A's context: confidential to workspace A\n", aAfter.body);
  const aBytes = await call(ALICE, "GET", `/api/dataroom?path=${encodeURIComponent(A_PDF)}&as=bytes`);
  check("…and her PDF's bytes", aBytes.status === 200 && aBytes.text === "%PDF-1.7 A's board pack" && aBytes.headers.get("content-type") === "application/pdf", { status: aBytes.status });
  const history = await admin`select org_id, path, prev_blob_key from dataroom_file_versions where org_id in (${A}, ${B}) and prev_blob_key is not null`;
  check("version snapshots, where one was taken, are inside the writer's own tree", history.every((h) => existsSync(join(STORE, "objects", keyOf(h.org_id, h.prev_blob_key)))), history);

  console.log("\n5. Naming A's workspace is refused");
  for (const [method, path, body] of [["GET", "/api/dataroom", undefined], ["GET", `/api/dataroom?path=${encodeURIComponent(CONTEXT)}`, undefined], ["POST", "/api/ops/dataroom", { path: CONTEXT, content: "pwned\n" }]]) {
    const r = await call(BOB, method, path, { json: body, org: A });
    check(`${method} ${path} as Bob naming workspace A → 403, nothing shown`, r.status === 403 && leaks(r).length === 0, { status: r.status, text: r.text.slice(0, 160) });
  }
  check("…and A's file is still A's", diskText(keyOf(A, CONTEXT)) === "A's context: confidential to workspace A\n");

  console.log("\n6. Artifacts and signed links");
  // The agent's side: publish into A's workspace with the same settings the server has (the agent is another process).
  Object.assign(process.env, storageEnv);
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const { publishArtifact } = await import("../agent/lib/artifact.ts");
  const report = await publishArtifact({ orgId: A, filename: "status report.html", content: "<h1>A's report</h1><script>document.title = String(window.origin)</script>" });
  check("the agent's published link points at this server's own object route", report.url.startsWith(`${base}/api/storage/object/artifacts/orgs/${A}/status%20report-`) && /[?&]exp=\d+&sig=/.test(report.url), report.url);
  const qPath = encodeURIComponent(report.pathname);
  const bobLink = await call(BOB, "GET", `/api/ops/artifact-link?path=${qPath}`);
  check("Bob gets no link for A's artifact by its path (404)", bobLink.status === 404 && !bobLink.body?.url, bobLink.body);
  const bobLinkUrl = await call(BOB, "GET", `/api/ops/artifact-link?url=${encodeURIComponent(report.url)}`);
  check("…nor by its published link", bobLinkUrl.status === 404 && !bobLinkUrl.body?.url, bobLinkUrl.body);
  const anonLink = await call(null, "GET", `/api/ops/artifact-link?path=${qPath}`);
  check("…and nobody gets one without signing in (401)", anonLink.status === 401, anonLink.status);
  const dataLink = await call(ALICE, "GET", `/api/ops/artifact-link?path=${encodeURIComponent(keyOf(A, CONTEXT))}`);
  check("the link route signs nothing in the data room, even the caller's own", dataLink.status === 400 && !dataLink.body?.url, dataLink.body);
  const aliceLink = await call(ALICE, "GET", `/api/ops/artifact-link?url=${encodeURIComponent(report.url)}`);
  check("Alice gets a fresh link from the published one", aliceLink.status === 200 && aliceLink.body?.path === report.pathname && aliceLink.body.url.startsWith(`${base}/api/storage/object/`), aliceLink.body);
  const fresh = aliceLink.body?.url ?? report.url;
  const direct = await fetch(fresh);
  const directText = await direct.text();
  check("the link serves the artifact with no session (it is the credential, like a presigned URL)", direct.status === 200 && directText.includes("A's report") && direct.headers.get("content-type")?.startsWith("text/html"), { status: direct.status, type: direct.headers.get("content-type") });
  check("…as a sandboxed document: its script cannot touch this site's origin", direct.headers.get("content-security-policy") === "sandbox allow-scripts" && direct.headers.get("x-content-type-options") === "nosniff", { csp: direct.headers.get("content-security-policy"), sniff: direct.headers.get("x-content-type-options") });
  check("…never stored by a shared cache", /private/.test(direct.headers.get("cache-control") ?? "") && /no-store/.test(direct.headers.get("cache-control") ?? ""), direct.headers.get("cache-control"));
  const proxied = await call(null, "GET", aliceLink.body?.proxyUrl ?? "/api/artifact-proxy");
  check("the artifact proxy follows it (the preview iframe's source)", proxied.status === 200 && proxied.text.includes("A's report"), { status: proxied.status, text: proxied.text.slice(0, 120) });

  const u = new URL(fresh);
  const bKey = keyOf(B, CONTEXT).split("/").map(encodeURIComponent).join("/");
  const bad = [
    ["no signature", `${u.origin}${u.pathname}`],
    ["a tampered signature", fresh.replace(/sig=.{6}/, "sig=AAAAAA")],
    ["a later expiry on the old signature", fresh.replace(/exp=\d+/, (m) => `exp=${Number(m.slice(4)) + 60_000}`)],
    ["the signature moved onto B's file", `${u.origin}/api/storage/object/${bKey}${u.search}`],
    ["the signature moved onto A's data-room file", `${u.origin}/api/storage/object/${keyOf(A, CONTEXT).split("/").map(encodeURIComponent).join("/")}${u.search}`],
    ["a climbing path", `${u.origin}/api/storage/object/artifacts/orgs/${A}/..%2F..%2F..%2F..%2Fetc%2Fpasswd${u.search}`],
    ["the folder itself", `${u.origin}/api/storage/object/artifacts/orgs/${A}/${u.search}`],
    ["the route with no key", `${u.origin}/api/storage/object${u.search}`],
    ["the storage root", `${u.origin}/api/storage/${u.search}`],
  ];
  for (const [label, target] of bad) {
    let r = await fetch(target, { redirect: "manual" });
    let hops = "";
    // Next answers a trailing slash with a 308 to the same path without it: no content, so follow it (same origin
    // only) and judge where it lands.
    for (let i = 0; i < 3 && r.status === 308; i++) {
      await r.arrayBuffer().catch(() => undefined);
      const next = new URL(r.headers.get("location") ?? "", target);
      if (next.origin !== new URL(target).origin) break;
      hops += "308 → ";
      r = await fetch(next, { redirect: "manual" });
    }
    const text = await r.text();
    check(`${label} → refused (${hops}${r.status}), no file content`, [400, 403, 404].includes(r.status) && !/A's report|A's context|B's own|root:/.test(text), { status: r.status, text: text.slice(0, 120) });
  }
  const { storageDriver } = await import("../lib/storage/index.ts");
  const expired = await storageDriver().signedUrl(report.pathname, -1000);
  check("an expired link → 403", (await fetch(expired.url)).status === 403);
  const viaProxy = await call(null, "GET", `/api/artifact-proxy?url=${encodeURIComponent(expired.url)}`);
  check("…and the proxy says it expired", viaProxy.status === 403 && viaProxy.body?.expired === true, viaProxy.body);
  for (const target of ["https://abc.private.blob.vercel-storage.com/artifacts/x.html", "http://169.254.169.254/latest/meta-data/", `${base}/api/ops/health`, `http://127.0.0.1:${port}/api/dataroom`]) {
    const r = await call(null, "GET", `/api/artifact-proxy?url=${encodeURIComponent(target)}`);
    check(`the proxy will not fetch ${target}`, r.status === 400, r.status);
  }
  for (const path of ["/objects/dataroom/orgs/" + A + "/" + CONTEXT, `/dataroom/orgs/${A}/${CONTEXT}`, `/_next/static/../../objects/dataroom/orgs/${A}/${CONTEXT}`]) {
    const r = await fetch(`${base}${path}`, { redirect: "manual" });
    check(`no public path onto the directory: GET ${path.slice(0, 60)} → ${r.status}`, r.status === 404 || r.status === 400 || r.status === 308 || r.status === 307, r.status);
    await r.arrayBuffer();
  }

  console.log("\n7. Health");
  const filesBefore = onDisk().length;
  const health = await call(null, "GET", "/api/ops/health");
  check("the health check probes the filesystem driver (write, head, delete)", health.body?.blob?.ok === true && health.body.blob.detail === "write → head → delete ok (filesystem)", health.body?.blob);
  check("…and leaves nothing behind", onDisk().length === filesBefore && !onDisk().some((k) => k.startsWith("_health")) && filesUnder(join(STORE, "tmp")).length === 0, { files: onDisk().filter((k) => k.startsWith("_health")), tmp: filesUnder(join(STORE, "tmp")) });
  const all = onDisk();
  check("at the end, every object on disk is under dataroom/orgs/<A|B>/ or artifacts/orgs/<A>/", all.every((k) => k.startsWith(`dataroom/orgs/${A}/`) || k.startsWith(`dataroom/orgs/${B}/`) || k.startsWith(`artifacts/orgs/${A}/`)), all);
  check("…and nothing of A's holds a byte Bob wrote", all.filter((k) => k.includes(`/orgs/${A}/`)).every((k) => !/Bob|B's|pwned/.test(diskText(k))));
} catch (error) {
  failures.push("the test ran to completion");
  console.error(`  FAIL the test threw: ${error?.stack ?? error}`);
  if (log) console.error(`--- server log ---\n${log.slice(-3000)}`);
} finally {
  server?.kill("SIGTERM");
  await unseed();
  await admin.end({ timeout: 5 }).catch(() => {});
  rmSync(STORE, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
