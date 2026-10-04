/**
 * A MISCONFIGURED FILE STORE FAILS LOUDLY. IT IS NOT "NOT CONFIGURED", AND NOT AN EMPTY DATA ROOM.
 *
 * Before this test's fix, lib/storage/index.ts `storageConfigured()` swallowed the StorageConfigError and answered
 * `false`. So with STORAGE_DRIVER mistyped (`filesytem`), or a selected driver missing a setting:
 *
 *   GET /api/dataroom            200 {"paths":[]}                    an empty data room
 *   GET /api/ops/dataroom        503 "Data room storage is not configured."
 *   GET /api/artifact-proxy      400 "Artifact host is not allowed"
 *   GET /api/storage/object/…    404 "Not found"
 *
 * each of which is the answer for something else. This holds the two apart:
 *
 *   1. NOT CONFIGURED (the default driver, no BLOB_READ_WRITE_TOKEN) is byte-for-byte what it was: the bodies above,
 *      no log line. So is the default driver WITH a token. Nothing here changes for a deployment that sets nothing.
 *   2. MISCONFIGURED is a 503 with `code: "storage_misconfigured"` and a sentence naming the setting on every storage
 *      route a signed-in caller can reach; the same 503 without the setting's name on the two routes that take no
 *      sign-in; the same error thrown by the agent's store and by publish_artifact (no fall-back to its local scratch
 *      tree, no write to Vercel Blob); the health check names it; and the server log has it ONCE.
 *   3. It is checked at startup: loading the module logs it, in a plain `node` process with no `react-server`
 *      condition (which is also the proof that the agent and the operator scripts can still import these modules).
 *   4. The server-only guard: lib/storage/server-guard.ts throws in a browser and nowhere else.
 *
 *   npm run test:storage-misconfigured
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import vm from "node:vm";

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

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 600)}`}`);
  }
};
const attempt = async (fn) => {
  try {
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, name: error?.name, message: String(error?.message ?? error) };
  }
};

const SCRATCH = mkdtempSync(join(tmpdir(), "storage-misconfigured-"));
const SECRET = "test-signing-secret-0123456789abcdef-not-a-real-one";
const STORAGE_ENV = ["STORAGE_DRIVER", "STORAGE_FS_ROOT", "STORAGE_SIGNING_SECRET", "STORAGE_PUBLIC_URL", "WEB_ORIGIN", "STORAGE_S3_ENDPOINT", "STORAGE_S3_BUCKET", "STORAGE_S3_REGION", "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY", "STORAGE_S3_ADDRESSING", "BLOB_READ_WRITE_TOKEN"];
for (const name of [...STORAGE_ENV, "DATABASE_URL", "POSTGRES_URL", "EVE_API_URL", "NEXT_PUBLIC_EVE_API_URL", "TASK_WORKFLOW_SERVICE_URL"]) delete process.env[name];
// The agent's local scratch tree, were it ever to fall back to it: here, where the test can see it stay empty.
process.env.DATAROOM_DIR = join(SCRATCH, "local-scratch");
function useEnv(settings) {
  for (const name of STORAGE_ENV) delete process.env[name];
  Object.assign(process.env, settings);
}

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const { installFakeBlob } = await import("./lib/fake-blob.mjs");
const blob = installFakeBlob();
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
useEnv({});

// Everything written to console.error from here on, so "logged once" and "nothing logged" are both countable.
const logged = [];
const realError = console.error;
console.error = (...args) => logged.push(args.map(String).join(" "));
const storageLines = () => logged.filter((line) => line.startsWith("[storage] MISCONFIGURED"));

const { NextRequest } = await import("next/server");
const storage = await import("../lib/storage/index.ts");
const settings = await import("../lib/storage/settings.ts");
// Absent on the code before the fix: the checks below then FAIL by name instead of the file stopping at the first one.
const configError = (env) => (typeof storage.storageConfigError === "function" ? (env ? storage.storageConfigError(env) : storage.storageConfigError()) : undefined);
const resetReports = () => settings.resetStorageConfigReports?.();
const store = await import("../agent/lib/dataroom-store.ts");
const artifact = await import("../agent/lib/artifact.ts");
const safeFetch = await import("../lib/safe-fetch.ts");
const { FOLDER: F } = await import("../agent/lib/dataroom-folders.ts");
const { mintSessionToken } = await import("../lib/auth-session.ts");
const bearer = `Bearer ${await mintSessionToken("reader@onfinance.in")}`;
const A = "icici-hfc";

const call = async (mod, method, url, init = {}) => {
  const handlers = await import(mod);
  const request = new NextRequest(url, { method, headers: { authorization: bearer, ...(init.headers ?? {}) }, body: init.body });
  const res = await handlers[method](request, init.context);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, body, text };
};
const H = "http://storage.test";
const FILE = `${F.accounts}/acme-bank/context.md`;
const upload = () => {
  const form = new FormData();
  form.set("file", new File(["hello"], "note.txt", { type: "text/plain" }));
  return form;
};

/** The storage routes a signed-in caller reaches, each as a thunk. */
const SIGNED_IN = [
  ["GET /api/dataroom (the listing)", () => call("../app/api/dataroom/route.ts", "GET", `${H}/api/dataroom`)],
  ["GET /api/dataroom?path= (one file)", () => call("../app/api/dataroom/route.ts", "GET", `${H}/api/dataroom?path=${encodeURIComponent(FILE)}`)],
  ["GET /api/dataroom?path=&as=bytes (the PDF viewer)", () => call("../app/api/dataroom/route.ts", "GET", `${H}/api/dataroom?path=${encodeURIComponent(`${F.uploads}/x/a.pdf`)}&as=bytes`)],
  ["GET /api/ops/dataroom", () => call("../app/api/ops/dataroom/route.ts", "GET", `${H}/api/ops/dataroom`)],
  ["POST /api/ops/dataroom (a write)", () => call("../app/api/ops/dataroom/route.ts", "POST", `${H}/api/ops/dataroom`, { headers: { "content-type": "application/json" }, body: JSON.stringify({ path: FILE, content: "x" }) })],
  ["POST /api/ops/upload", () => call("../app/api/ops/upload/route.ts", "POST", `${H}/api/ops/upload`, { body: upload() })],
  ["GET /api/ops/artifact-link", () => call("../app/api/ops/artifact-link/route.ts", "GET", `${H}/api/ops/artifact-link?path=${encodeURIComponent("artifacts/orgs/org-onfinance/r.html")}`)],
  ["GET /api/ops/export", () => call("../app/api/ops/export/route.ts", "GET", `${H}/api/ops/export?type=customer&id=x`)],
  ["GET /api/ops/dataroom/changesets/<id>", () => call("../app/api/ops/dataroom/changesets/[id]/route.ts", "GET", `${H}/api/ops/dataroom/changesets/x`, { context: { params: Promise.resolve({ id: "x" }) } })],
];
/** The two that take no sign-in. */
const PUBLIC = [
  ["GET /api/artifact-proxy", () => call("../app/api/artifact-proxy/route.ts", "GET", `${H}/api/artifact-proxy?url=${encodeURIComponent("https://abc.private.blob.vercel-storage.com/artifacts/orgs/org-onfinance/r.html")}`)],
  ["GET /api/storage/object/<key>", () => call("../app/api/storage/object/[...key]/route.ts", "GET", `${H}/api/storage/object/artifacts/orgs/org-onfinance/r.html?exp=1&sig=x`)],
];

try {
  /* ---- 1. not configured, and the default driver with a token: unchanged ---------------------------------------- */
  console.log("1. Nothing set: the default driver, exactly as before");
  for (const [label, env] of [["STORAGE_DRIVER unset, no token", {}], ["STORAGE_DRIVER=vercel-blob, no token", { STORAGE_DRIVER: "vercel-blob" }], ["STORAGE_DRIVER empty, no token", { STORAGE_DRIVER: "  " }]]) {
    useEnv(env);
    logged.length = 0;
    blob.calls.length = 0;
    check(`${label}: no error to report, and "configured" is false (not a throw)`, !configError() && storage.storageConfigured() === false && storage.storageDriver() === null);
    const list = await call("../app/api/dataroom/route.ts", "GET", `${H}/api/dataroom`);
    check(`${label}: GET /api/dataroom is still 200 {"paths":[]}`, list.status === 200 && list.text === '{"paths":[]}', list);
    const ops = await call("../app/api/ops/dataroom/route.ts", "GET", `${H}/api/ops/dataroom`);
    check(`${label}: GET /api/ops/dataroom is still 503 "Data room storage is not configured."`, ops.status === 503 && ops.text === '{"error":"Data room storage is not configured."}', ops);
    const up = await call("../app/api/ops/upload/route.ts", "POST", `${H}/api/ops/upload`, { body: upload() });
    check(`${label}: POST /api/ops/upload is still that 503`, up.status === 503 && up.text === '{"error":"Data room storage is not configured."}', up);
    const link = await call("../app/api/ops/artifact-link/route.ts", "GET", `${H}/api/ops/artifact-link?path=artifacts%2Forgs%2Forg-onfinance%2Fr.html`);
    check(`${label}: GET /api/ops/artifact-link is still 503 "Artifact storage is not configured."`, link.status === 503 && link.text === '{"error":"Artifact storage is not configured."}', link);
    const object = await PUBLIC[1][1]();
    check(`${label}: GET /api/storage/object is still 404 "Not found"`, object.status === 404 && object.text === '{"error":"Not found"}', object);
    const proxied = await call("../app/api/artifact-proxy/route.ts", "GET", `${H}/api/artifact-proxy?url=${encodeURIComponent("https://example.org/a.html")}`);
    check(`${label}: the artifact proxy still refuses another host with 400 "Artifact host is not allowed"`, proxied.status === 400 && proxied.text === '{"error":"Artifact host is not allowed"}', proxied);
    const pub = await attempt(() => artifact.publishArtifact({ orgId: A, filename: "x.html", content: "x" }));
    check(`${label}: publish_artifact still says which variable to set`, pub.threw && pub.name === "Error" && pub.message.startsWith("Artifact publishing is not configured: set BLOB_READ_WRITE_TOKEN"), pub);
    check(`${label}: the agent's store still falls back to its local scratch tree`, store.createDataroomStore({ orgId: A }).backend.kind === "local");
    check(`${label}: a workflow script's read of a file is still null (missing), not an error`, (await (await import("../lib/workflow-data.ts")).workflowDataFor(A).dataroomRead(FILE)) === null);
    check(`${label}: no request reached Vercel Blob, and nothing was logged`, blob.calls.length === 0 && logged.length === 0, { calls: blob.calls.length, logged });
  }
  {
    useEnv({ BLOB_READ_WRITE_TOKEN: BLOB_TOKEN });
    logged.length = 0;
    blob.calls.length = 0;
    check("with the token: no error to report, the Vercel Blob driver", !configError() && storage.storageConfigured() === true && storage.storageDriver()?.kind === "vercel-blob");
    const list = await call("../app/api/dataroom/route.ts", "GET", `${H}/api/dataroom`);
    check("with the token: GET /api/dataroom lists from Vercel Blob (one list call) and is 200", list.status === 200 && Array.isArray(list.body?.paths) && blob.calls.length === 1 && blob.calls[0].op === "list", { list, calls: blob.calls });
    check("with the token: nothing was logged", logged.length === 0, logged);
  }

  /* ---- 2. misconfigured -------------------------------------------------------------------------------------- */
  const CASES = [
    ["STORAGE_DRIVER mistyped (filesytem), a Vercel Blob token present", { STORAGE_DRIVER: "filesytem", BLOB_READ_WRITE_TOKEN: BLOB_TOKEN }, "STORAGE_DRIVER"],
    ["STORAGE_DRIVER=filesystem without STORAGE_FS_ROOT, a Vercel Blob token present", { STORAGE_DRIVER: "filesystem", STORAGE_SIGNING_SECRET: SECRET, STORAGE_PUBLIC_URL: "https://app.storage.test", BLOB_READ_WRITE_TOKEN: BLOB_TOKEN }, "STORAGE_FS_ROOT"],
    ["STORAGE_DRIVER=filesystem with a short STORAGE_SIGNING_SECRET", { STORAGE_DRIVER: "filesystem", STORAGE_FS_ROOT: join(SCRATCH, "fs"), STORAGE_SIGNING_SECRET: "too-short-secret-value", STORAGE_PUBLIC_URL: "https://app.storage.test" }, "STORAGE_SIGNING_SECRET"],
    ["STORAGE_DRIVER=s3 without STORAGE_S3_BUCKET", { STORAGE_DRIVER: "s3", STORAGE_S3_ENDPOINT: "https://blr1.digitaloceanspaces.com", STORAGE_S3_ACCESS_KEY_ID: "TESTKEY", STORAGE_S3_SECRET_ACCESS_KEY: "test-secret-access-key" }, "STORAGE_S3_BUCKET"],
  ];
  for (const [label, env, setting] of CASES) {
    console.log(`\n2. Misconfigured: ${label}`);
    useEnv(env);
    logged.length = 0;
    blob.calls.length = 0;
    resetReports();
    // Every value that was set, except a correctly spelled driver name (the message may say "STORAGE_DRIVER=filesystem").
    const values = Object.entries(env).filter(([name, v]) => !(name === "STORAGE_DRIVER" && ["filesystem", "s3"].includes(v))).map(([, v]) => v);

    const error = configError();
    check(`storageConfigError() returns the error, naming ${setting}`, error?.name === "StorageConfigError" && error.message.includes(setting), error?.message);
    const configured = await attempt(() => storage.storageConfigured());
    check(`storageConfigured() THROWS it (it used to answer false, which every route read as "not configured")`, configured.threw && configured.name === "StorageConfigError" && configured.message.includes(setting), configured);
    const driver = await attempt(() => storage.storageDriver());
    check("storageDriver() throws it too (never null, never another driver)", driver.threw && driver.name === "StorageConfigError", driver);

    for (const [name, go] of SIGNED_IN) {
      const r = await go();
      check(`${name}: 503, code storage_misconfigured, a sentence naming ${setting}`, r.status === 503 && r.body?.code === "storage_misconfigured" && typeof r.body.error === "string" && r.body.error.includes(setting) && r.body.error.includes("misconfigured"), r);
      check(`…not an empty listing, not "not configured", and no setting's value`, r.body?.paths === undefined && !/not configured/i.test(r.text) && values.every((v) => !r.text.includes(v)), r.text);
    }
    for (const [name, go] of PUBLIC) {
      const r = await go();
      check(`${name} (no sign-in): 503 and the same code, WITHOUT naming the setting`, r.status === 503 && r.body?.code === "storage_misconfigured" && !r.text.includes("STORAGE_") && values.every((v) => !r.text.includes(v)), r);
    }
    const health = await call("../app/api/ops/health/route.ts", "GET", `${H}/api/ops/health`);
    check(`the health check says MISCONFIGURED and names ${setting}`, health.body?.blob?.ok === false && health.body.blob.detail.includes("MISCONFIGURED") && health.body.blob.detail.includes(setting), health.body?.blob);

    const agentStore = await attempt(() => store.createDataroomStore({ orgId: A }));
    check(`the agent's store throws the same error (no local scratch tree, no Vercel Blob)`, agentStore.threw && agentStore.name === "StorageConfigError" && agentStore.message === error?.message, agentStore);
    const pub = await attempt(() => artifact.publishArtifact({ orgId: A, filename: "x.html", content: "x" }));
    check("publish_artifact throws the same error", pub.threw && pub.name === "StorageConfigError" && pub.message === error?.message, pub);
    const { workflowDataFor } = await import("../lib/workflow-data.ts");
    const scriptRead = await attempt(() => workflowDataFor(A).dataroomRead(FILE));
    check("a workflow script's data-room read fails with the same error (it used to read as a missing file: null)", scriptRead.threw && scriptRead.name === "StorageConfigError" && scriptRead.message === error?.message, scriptRead);
    check("a misconfigured store owns no host (a URL check stays a refusal, and does not throw)", safeFetch.isBlobHost("abc.private.blob.vercel-storage.com") === false && safeFetch.isBlobHost("app.storage.test") === false);

    check("nothing was sent to Vercel Blob, and nothing was written to the agent's local scratch tree", blob.calls.length === 0 && (!existsSync(process.env.DATAROOM_DIR) || readdirSync(process.env.DATAROOM_DIR, { recursive: true }).length === 0), blob.calls);
    const lines = storageLines();
    check(`the server log has it ONCE across all of the above (${SIGNED_IN.length + PUBLIC.length} routes, the health check, the agent)`, lines.length === 1, lines);
    check(`…naming ${setting}, saying it is not "not configured", with no value`, lines.length > 0 && lines[0].includes(setting) && lines[0].includes('not the same as "not configured"') && values.every((v) => !lines[0].includes(v)), lines[0]);
    check("…and nothing else was logged as an error", logged.length === lines.length, logged);
  }
  {
    console.log("\n2b. A second, different mistake is its own line");
    resetReports();
    logged.length = 0;
    configError({ STORAGE_DRIVER: "gcs" });
    configError({ STORAGE_DRIVER: "gcs" });
    configError({ STORAGE_DRIVER: "s3" });
    configError({ STORAGE_DRIVER: "s3" });
    check("two distinct messages, each once", storageLines().length === 2, storageLines());
    const http = await attempt(() => import("../lib/storage-http.ts"));
    check("an error that is not a StorageConfigError is not turned into a 503", !http.threw && http.value.storageErrorResponse(new Error("STORAGE_DRIVER")) === null && http.value.storageErrorResponse(new storage.StorageConfigError("x"))?.status === 503);
  }

  /* ---- 3. checked at startup, in plain node ------------------------------------------------------------------- */
  console.log("\n3. Checked when the module is loaded, in a plain `node` process (no react-server condition)");
  {
    const node = (code, env) =>
      spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      });
    const LOAD = (file) => `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), file)).href)}); console.log("loaded");`;
    for (const file of ["lib/storage/index.ts", "lib/storage/vercel-blob.ts", "agent/lib/artifact.ts"]) {
      const quiet = node(LOAD(file), {});
      check(`${file} loads with nothing set, and logs nothing`, quiet.status === 0 && quiet.stdout.trim() === "loaded" && quiet.stderr.trim() === "", { status: quiet.status, stderr: quiet.stderr.slice(0, 300) });
    }
    const token = node(LOAD("lib/storage/index.ts"), { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN });
    check("…and with only the Vercel Blob token (the live app's settings)", token.status === 0 && token.stderr.trim() === "", token.stderr.slice(0, 300));
    for (const file of ["lib/storage/index.ts", "agent/lib/artifact.ts"]) {
      const typo = node(LOAD(file), { STORAGE_DRIVER: "filesytem", BLOB_READ_WRITE_TOKEN: BLOB_TOKEN });
      const lines = typo.stderr.split("\n").filter((l) => l.startsWith("[storage] MISCONFIGURED"));
      check(`${file} with a mistyped STORAGE_DRIVER: the process starts, and its log has the mistake once, before any request`, typo.status === 0 && typo.stdout.trim() === "loaded" && lines.length === 1 && lines[0].includes("STORAGE_DRIVER"), { status: typo.status, stderr: typo.stderr.slice(0, 400) });
    }
  }

  /* ---- 4. the server-only guard ------------------------------------------------------------------------------- */
  console.log("\n4. The server-only guard");
  {
    const ts = createRequire(import.meta.url)("typescript");
    const js = ts.transpileModule(existsSync("lib/storage/server-guard.ts") ? readFileSync("lib/storage/server-guard.ts", "utf8") : "",  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const run = (globals) => attempt(() => vm.runInNewContext(js, { exports: {}, ...globals }));
    const browser = await run({ window: {}, document: {} });
    check("in a browser (a window and a document, not Node) it throws, naming the one module a client may import", browser.threw && browser.message.includes("server-only") && browser.message.includes("lib/storage/hosts.ts"), browser);
    check("…also when a bundler has put a `process.env` shim there", (await run({ window: {}, document: {}, process: { env: {} } })).threw);
    check("on a server (no window) it does nothing", !(await run({})).threw && !(await run({ process: { versions: { node: "24.0.0" } } })).threw);
    check("under Node with a DOM defined by a test, it does nothing", !(await run({ window: {}, document: {}, process: { versions: { node: "24.0.0" } } })).threw);
    const out = spawnSync(process.execPath, ["scripts/check-storage-server-only.mjs"], { encoding: "utf8" });
    check("no client component can reach lib/storage beyond hosts.ts, and every server module there starts with the guard (check:storage-server-only)", out.status === 0, (out.stdout + out.stderr).slice(-600));
    const first = (file) => readFileSync(file, "utf8").split("\n").find((line) => line.startsWith("import "));
    check("lib/storage/index.ts and lib/storage/vercel-blob.ts begin with the guard", first("lib/storage/index.ts") === 'import "./server-guard.ts";' && first("lib/storage/vercel-blob.ts") === 'import "./server-guard.ts";');
    check("the web-only helper that answers the 503 carries Next's own `server-only`", existsSync("lib/storage-http.ts") && first("lib/storage-http.ts") === 'import "server-only";');
  }
} finally {
  console.error = realError;
  rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const label of failed) console.log(`  FAILED: ${label}`);
  process.exit(1);
}
process.exit(0);
