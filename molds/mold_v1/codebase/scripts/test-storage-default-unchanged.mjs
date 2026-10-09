/**
 * THE DEFAULT STORAGE DRIVER MAKES TODAY'S EXACT VERCEL BLOB CALLS.
 *
 * The live app runs on Vercel Blob. Putting a storage driver between the application and `@vercel/blob` must change
 * nothing there: not which operations are made, not their order, not a key, not an option, not a URL handed back.
 *
 * This script drives every code path that touches the file store, through entry points that exist both BEFORE the
 * driver (commit 6f10b09) and after it, and records four things:
 *
 *   calls    every call into `@vercel/blob` (operation, key, options), in order, as the library received it
 *            (scripts/lib/blob-call-recorder.mjs stands in for the module, for whichever file imports it);
 *   wire     every HTTP request the library then sent (method, path and query, the option headers, a digest of the
 *            body), and every GET of a presigned object URL (scripts/lib/fake-blob.mjs);
 *   fetches  every read of a signed object URL the app made itself, with the options it passed to fetch;
 *   results  what each entry point returned: paths, contents, pathnames, signed URLs, expiry times, HTTP statuses.
 *
 * The recording made on the code before the driver is committed at
 * scripts/fixtures/storage/default-driver.golden.json. It was written by running THIS file, unmodified, in a checkout
 * of 6f10b09 with only this script, the recorder and the fake store's wire log added:
 *
 *     node --experimental-strip-types --conditions=react-server scripts/test-storage-default-unchanged.mjs --record
 *
 * and this test asserts the current code produces the identical recording, with STORAGE_DRIVER unset and again with
 * STORAGE_DRIVER=vercel-blob (`npm run test:storage-default`). Time and the one random value (the append-part nonce)
 * are pinned so the recording is exact, not approximate.
 *
 * It is a regression pin, so it passes on both sides by construction; a drift in any call fails it and prints the
 * first difference.
 */
import { createRequire, register, syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mock } from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { DEFAULT_ORG as ORG_ONE } from "./lib/default-org.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { stringifyRecorded } = await import(pathToFileURL(join(HERE, "lib", "json-text.mjs")).href);
const GOLDEN = join(HERE, "fixtures", "storage", "default-driver.golden.json");
const RECORD = process.argv.includes("--record");
const RECORDER = pathToFileURL(join(HERE, "lib", "blob-call-recorder.mjs")).href;

// The web app's `@/` alias and extensionless imports (as scripts/test-dataroom-isolation.mjs), plus the one redirect
// this test is about: `@vercel/blob` resolves to the recorder for every importer but the recorder itself.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      const RECORDER = ${JSON.stringify(RECORDER)};
      export async function resolve(s, c, n) {
        if (s === "@vercel/blob" && c.parentURL !== RECORDER) return { url: RECORDER, shortCircuit: true };
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

// --- pinned time and randomness ---------------------------------------------------------------------------------
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
mock.timers.enable({ apis: ["Date"], now: NOW });
{
  // The append-part key carries 4 random bytes; pin them so keys (and the URLs signed for them) are exact.
  const require = createRequire(import.meta.url);
  const nodeCrypto = require("node:crypto");
  nodeCrypto.randomBytes = (n) => Buffer.alloc(n, 0xab);
  syncBuiltinESMExports();
}

// The settings this test is about. The explicit pass sets STORAGE_DRIVER=vercel-blob in the environment.
const DRIVER_SETTING = process.env.STORAGE_DRIVER ?? "(unset)";
if (process.env.STORAGE_DRIVER !== undefined && process.env.STORAGE_DRIVER !== "vercel-blob") {
  console.error(`this test is about the default driver; STORAGE_DRIVER=${process.env.STORAGE_DRIVER} is not it`);
  process.exit(2);
}
for (const name of ["DATABASE_URL", "POSTGRES_URL", "EVE_API_URL", "NEXT_PUBLIC_EVE_API_URL", "TASK_WORKFLOW_SERVICE_URL", "DATAROOM_DIR"]) {
  delete process.env[name];
}

const { installFakeBlob } = await import("./lib/fake-blob.mjs");
const blob = installFakeBlob();
const { calls } = await import("./lib/blob-call-recorder.mjs");

// The app reads a private object by fetching a signed URL itself. What it passes to fetch (`cache: "no-store"` in the
// web runtime, nothing in the agent) is part of today's behaviour and is not visible on the wire, so it is recorded
// here: every fetch of a store-host URL, with its options.
const fetches = [];
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = function recordedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    if (typeof url === "string" && /^https:\/\/[^/]*vercel-storage\.com\//.test(url)) {
      fetches.push({ url, init: init === undefined ? "<undefined>" : JSON.parse(JSON.stringify(init)) });
    }
    return realFetch.call(this, input, init);
  };
}

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

// --- recording --------------------------------------------------------------------------------------------------
const results = [];
const digest = (bytes) => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
function plain(value) {
  if (value === undefined) return "<undefined>";
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return digest(Buffer.from(value));
  if (Array.isArray(value)) return value.length > 40 ? { items: value.length, first: value.slice(0, 3).map(plain), last: plain(value[value.length - 1]) } : value.map(plain);
  const out = {};
  for (const key of Object.keys(value).sort()) if (key !== "ms") out[key] = plain(value[key]);
  return out;
}
/** Run one step; record what it returned (or the error it threw). */
async function step(label, fn) {
  const from = { calls: calls.length, wire: blob.wire.length };
  let outcome;
  try {
    outcome = { returned: plain(await fn()) };
  } catch (error) {
    outcome = { threw: String(error?.message ?? error) };
  }
  results.push({ step: label, ...outcome, blobCalls: calls.length - from.calls, requests: blob.wire.length - from.wire });
}
const quietly = async (fn) => {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
};

const A = "customer-b";
const B = "desk-a";
/** The workspace a signed-in caller resolves to with no database (lib/org-context.ts). */
const DEFAULT_ORG = ORG_ONE;

const { NextRequest } = await import("next/server");
const { mintSessionToken } = await import("../lib/auth-session.ts");
const bearer = `Bearer ${await mintSessionToken("reader@example.com")}`;
async function route(mod, method, url, init = {}) {
  const handlers = await import(mod);
  const headers = { authorization: bearer, ...(init.headers ?? {}) };
  const res = await handlers[method](new NextRequest(url, { method, headers, body: init.body }));
  const type = res.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await res.arrayBuffer());
  let body;
  if (type.includes("application/json")) {
    body = JSON.parse(bytes.toString("utf8"));
  } else {
    body = digest(bytes);
  }
  return { status: res.status, contentType: type, body };
}

/** The deployment's stored folder names (agent/lib/dataroom-folders.ts): the scenario's paths are built from them. */
const { FOLDER: F } = await import("../agent/lib/dataroom-folders.ts");

async function scenario() {
  const store = await import("../agent/lib/dataroom-store.ts");
  const artifact = await import("../agent/lib/artifact.ts");
  const web = await import("../lib/dataroom-blob.ts");

  /* ---- the agent's data-room store ------------------------------------------------------------------------- */
  const a = store.createDataroomStore({ orgId: A });
  await step("agent store: backend kind", () => a.backend.kind);
  await step("agent store: write a markdown file", () => a.write(`${F.accounts}/acme-bank/context.md`, "# Acme Bank\n\nA's context.\n"));
  await step("agent store: write a json file", () => a.write(`${F.deliveries}/acme-bank/2026.06.3/platform/organization.json`, '{"a":1}'));
  await step("agent store: write a terraform file", () => a.write(`${F.deliveries}/acme-bank/2026.06.3/infrastructure/inference/customizations.tf`, "# tf\n"));
  await step("agent store: write a binary-typed path", () => a.write(`${F.uploads}/priya-example-org/board-pack.pdf`, "%PDF-1.7 not really\n"));
  await step("agent store: write a workbook path", () => a.write(`${F.accounts}/Master.xlsx`, "PK not really"));
  await step("agent store: write a jsonl file (no trailing newline given)", () => a.write(`${F.accounts}/acme-bank/interactions.jsonl`, '{"interactionId":"INT-0"}'));
  await step("agent store: append one record", () => a.appendJsonl(`${F.accounts}/acme-bank/interactions.jsonl`, { interactionId: "INT-1" }));
  await step("agent store: append two records", () => a.appendJsonl(`${F.accounts}/acme-bank/interactions.jsonl`, [{ interactionId: "INT-2" }, { interactionId: "INT-3" }]));
  await step("agent store: append to a file with no base object", () => a.appendJsonl(`${F.people}/sam-example-com/interactions.jsonl`, { interactionId: "P-1" }));
  await step("agent store: read markdown", () => a.read(`${F.accounts}/acme-bank/context.md`));
  await step("agent store: read jsonl (base + parts)", () => a.read(`${F.accounts}/acme-bank/interactions.jsonl`));
  await step("agent store: readJsonl (parts only)", () => a.readJsonl(`${F.people}/sam-example-com/interactions.jsonl`));
  await step("agent store: read a missing file", () => a.read(`${F.accounts}/nobody/context.md`));
  await step("agent store: readBytes", () => a.readBytes(`${F.uploads}/priya-example-org/board-pack.pdf`));
  await step("agent store: readBytes of a missing file", () => a.readBytes(`${F.uploads}/priya-example-org/missing.pdf`));
  await step("agent store: downloadUrl", () => a.downloadUrl(`${F.uploads}/priya-example-org/board-pack.pdf`));
  await step("agent store: list everything", () => a.list(""));
  await step("agent store: list a prefix", () => a.list(`${F.accounts}/acme-bank`));
  await step("agent store: list a prefix with a trailing slash", () => a.list(`${F.accounts}/`));
  await step("agent store: overwrite the jsonl (retires its append parts)", () => a.write(`${F.accounts}/acme-bank/interactions.jsonl`, '{"interactionId":"INT-9"}\n'));
  await step("agent store: read it back", () => a.read(`${F.accounts}/acme-bank/interactions.jsonl`));
  await step("agent store: overwrite a file that has no parts", () => a.write(`${F.accounts}/acme-bank/context.md`, "# Acme Bank, again\n"));
  await step("agent store: an invalid path is refused before any call", () => a.write("../escape.md", "x"));

  const viaToken = store.createBlobDataroomStore({ orgId: B, token: process.env.BLOB_READ_WRITE_TOKEN });
  await step("agent store (explicit token): write", () => viaToken.write(`${F.accounts}/zeta/context.md`, "# Zeta (B)\n"));
  await step("agent store (explicit token): list", () => viaToken.list(""));
  const viaOption = store.createDataroomStore({ orgId: B, blobToken: process.env.BLOB_READ_WRITE_TOKEN });
  await step("agent store (blobToken option): read", () => viaOption.read(`${F.accounts}/zeta/context.md`));
  await step("agent store: the shared per-workspace store", async () => {
    const shared = store.getDataroomStore(B);
    return { same: shared === store.getDataroomStore(B), kind: shared.backend.kind, list: await shared.list(`${F.accounts}`) };
  });
  await step("agent store: no workspace is refused before any call", () => store.createDataroomStore({}).list(""));

  /* ---- a listing longer than one page ---------------------------------------------------------------------- */
  for (let i = 0; i < 1005; i++) blob.seed(`dataroom/orgs/${B}/${F.accounts}/bulk/agreements/doc-${String(i).padStart(4, "0")}.md`, `doc ${i}\n`, 1000 + i);
  await step("agent store: list across two pages (1006 objects)", () => viaToken.list(`${F.accounts}`));
  await step("web reader: list across two pages", () => web.listDataroomPaths(B));

  /* ---- the agent's tools ------------------------------------------------------------------------------------ */
  const tools = await import("../agent/lib/dataroom-tools.ts");
  const ctx = { session: { id: "storage-probe", auth: { current: null, initiator: null } } };
  await step("dataroom_write tool", () => quietly(() => tools.dataroomWriteTool.execute({ path: `${F.uploads}/sam-example-com/notes.md`, content: "notes\n" }, ctx)));
  await step("dataroom_list tool", () => tools.dataroomListTool.execute({}, ctx));
  await step("dataroom_read tool", () => tools.dataroomReadTool.execute({ path: `${F.uploads}/sam-example-com/notes.md` }, ctx));
  await step("dataroom_fetch_to_sandbox tool (the signed link handed to the sandbox)", () =>
    tools.dataroomFetchToSandboxTool.execute({ path: `${F.uploads}/sam-example-com/notes.md` }, ctx),
  );

  /* ---- publish_artifact ------------------------------------------------------------------------------------- */
  let published;
  await step("publish_artifact: an html report", async () => (published = await artifact.publishArtifact({ orgId: A, filename: "status-report.html", content: "<h1>Status</h1>" })));
  await step("publish_artifact: bytes with an explicit type", () => artifact.publishArtifact({ orgId: A, filename: "tracker.xlsx", content: Buffer.from("PK workbook bytes"), contentType: "application/x-test" }));
  await step("publish_artifact: an unknown extension", () => artifact.publishArtifact({ orgId: DEFAULT_ORG, filename: "blob.weird", content: "?" }));
  await step("publish_artifact: no workspace is refused before any call", () => artifact.publishArtifact({ orgId: "", filename: "x.md", content: "x" }));

  /* ---- the web app's reader/writer (lib/dataroom-blob.ts) --------------------------------------------------- */
  await step("web: write with a content type", () => web.writeDataroomFile(`${F.uploads}/priya-example-org/deck.pdf`, Buffer.from("%PDF-1.7 deck"), "application/pdf", A));
  await step("web: write without a content type", () => web.writeDataroomFile(`${F.accounts}/acme-bank/personas.jsonl`, '{"p":1}\n', undefined, A));
  await step("web: list", () => web.listDataroomPaths(A));
  await step("web: read (base only)", () => web.readDataroomFile(`${F.accounts}/acme-bank/context.md`, A));
  await step("web: read (parts only)", () => web.readDataroomFile(`${F.people}/sam-example-com/interactions.jsonl`, A));
  await step("web: read a missing file", () => web.readDataroomFile(`${F.accounts}/nobody/context.md`, A));
  await step("web: stat", () => web.statDataroomObject(`${F.uploads}/priya-example-org/deck.pdf`, A));
  await step("web: stat a missing file", () => web.statDataroomObject(`${F.uploads}/priya-example-org/none.pdf`, A));
  await step("web: open (raw bytes)", async () => {
    const res = await web.openDataroomObject(`${F.uploads}/priya-example-org/deck.pdf`, A);
    return res && { status: res.status, contentType: res.headers.get("content-type"), body: Buffer.from(await res.arrayBuffer()) };
  });
  await step("web: open a missing file", () => web.openDataroomObject(`${F.uploads}/priya-example-org/none.pdf`, A));
  const snap = `_versions/${A}/1700000000000-${F.accounts}/acme-bank/context.md`;
  await step("web: write a snapshot", () => web.writeSnapshotObject(snap, "# before\n", A));
  await step("web: read a snapshot", () => web.readSnapshotObject(snap, A));
  await step("web: another workspace's snapshot key is refused before any call", () => web.readSnapshotObject(snap, B));
  await step("web: no workspace is refused before any call", () => web.listDataroomPaths());

  const { workflowDataFor } = await import("../lib/workflow-data.ts");
  await step("workflow data: list", () => workflowDataFor(A).dataroomList(`${F.accounts}`));
  await step("workflow data: read", () => workflowDataFor(A).dataroomRead(`${F.accounts}/acme-bank/context.md`));

  /* ---- the routes, as a signed-in request ------------------------------------------------------------------- */
  await step("GET /api/dataroom (list)", () => route("../app/api/dataroom/route.ts", "GET", "http://storage.test/api/dataroom"));
  await step("GET /api/dataroom?path= (text)", () => route("../app/api/dataroom/route.ts", "GET", `http://storage.test/api/dataroom?path=${F.uploads}/sam-example-com/notes.md`));
  await step("GET /api/dataroom?path= (missing)", () => route("../app/api/dataroom/route.ts", "GET", `http://storage.test/api/dataroom?path=${F.uploads}/sam-example-com/none.md`));
  await step("POST /api/ops/upload", async () => {
    const form = new FormData();
    form.set("file", new File([Buffer.from("%PDF-1.7 uploaded")], "Board Pack (final).pdf", { type: "application/pdf" }));
    const handlers = await import("../app/api/ops/upload/route.ts");
    const res = await handlers.POST(new NextRequest("http://storage.test/api/ops/upload", { method: "POST", headers: { authorization: bearer }, body: form }));
    return { status: res.status, body: await res.json() };
  });
  await step("GET /api/dataroom?path=…&as=bytes (the PDF viewer)", () =>
    route("../app/api/dataroom/route.ts", "GET", `http://storage.test/api/dataroom?path=${encodeURIComponent("${F.uploads}/reader-example-com/Board Pack _final_.pdf")}&as=bytes`),
  );
  await step("GET /api/dataroom?path=…&as=bytes (missing)", () => route("../app/api/dataroom/route.ts", "GET", `http://storage.test/api/dataroom?path=${F.uploads}/reader-example-com/none.pdf&as=bytes`));
  await step("GET /api/ops/dataroom (list with a prefix)", () => route("../app/api/ops/dataroom/route.ts", "GET", `http://storage.test/api/ops/dataroom?prefix=${F.uploads}`));
  await step("GET /api/ops/dataroom?path=", () => route("../app/api/ops/dataroom/route.ts", "GET", `http://storage.test/api/ops/dataroom?path=${F.uploads}/sam-example-com/notes.md`));
  const post = (body) =>
    quietly(() => route("../app/api/ops/dataroom/route.ts", "POST", "http://storage.test/api/ops/dataroom", { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  await step("POST /api/ops/dataroom (create)", () => post({ path: `${F.accounts}/new-co/context.md`, content: "# New\n" }));
  await step("POST /api/ops/dataroom (overwrite: snapshots the previous bytes first)", () => post({ path: `${F.accounts}/new-co/context.md`, content: "# Newer\n" }));
  await step("POST /api/ops/dataroom (append)", () => post({ path: `${F.accounts}/new-co/interactions.jsonl`, content: '{"i":1}', append: true }));
  await step("POST /api/ops/dataroom (append again)", () => post({ path: `${F.accounts}/new-co/interactions.jsonl`, content: '{"i":2}', append: true }));

  let link;
  await step("GET /api/ops/artifact-link?path= (own workspace)", async () => (link = await route("../app/api/ops/artifact-link/route.ts", "GET", `http://storage.test/api/ops/artifact-link?path=${encodeURIComponent(`artifacts/orgs/${DEFAULT_ORG}/blob.weird`)}`)));
  await step("GET /api/ops/artifact-link?url= (the published link)", () =>
    route("../app/api/ops/artifact-link/route.ts", "GET", `http://storage.test/api/ops/artifact-link?url=${encodeURIComponent(`https://fakestore.private.blob.vercel-storage.com/artifacts/orgs/${DEFAULT_ORG}/blob.weird?vercel-blob-delegation=old`)}`),
  );
  await step("GET /api/ops/artifact-link (another workspace's artifact)", () =>
    route("../app/api/ops/artifact-link/route.ts", "GET", `http://storage.test/api/ops/artifact-link?path=${encodeURIComponent(published?.pathname ?? `artifacts/orgs/${A}/status-report.html`)}`),
  );
  await step("GET /api/ops/artifact-link (a link on another host)", () =>
    route("../app/api/ops/artifact-link/route.ts", "GET", `http://storage.test/api/ops/artifact-link?url=${encodeURIComponent("https://example.org/artifacts/x.html")}`),
  );
  await step("GET /api/artifact-proxy (the fresh link)", () => route("../app/api/artifact-proxy/route.ts", "GET", `http://storage.test/api/artifact-proxy?url=${encodeURIComponent(link?.body?.url ?? "")}`));
  await step("GET /api/artifact-proxy (a missing object)", () =>
    route("../app/api/artifact-proxy/route.ts", "GET", `http://storage.test/api/artifact-proxy?url=${encodeURIComponent("https://fakestore.private.blob.vercel-storage.com/artifacts/none.html?x=1")}`),
  );
  await step("GET /api/artifact-proxy (another host is refused)", () => route("../app/api/artifact-proxy/route.ts", "GET", `http://storage.test/api/artifact-proxy?url=${encodeURIComponent("https://example.org/a.html")}`));
  await step("GET /api/artifact-proxy (http is refused)", () => route("../app/api/artifact-proxy/route.ts", "GET", `http://storage.test/api/artifact-proxy?url=${encodeURIComponent("http://fakestore.private.blob.vercel-storage.com/artifacts/a.html")}`));

  await step("GET /api/ops/health (the storage probe: write, head, delete)", async () => {
    const res = await quietly(() => route("../app/api/ops/health/route.ts", "GET", "http://storage.test/api/ops/health"));
    return { blob: res.body.blob };
  });

  /* ---- the host rules ---------------------------------------------------------------------------------------- */
  const safeFetch = await import("../lib/safe-fetch.ts");
  await step("safe-fetch: which hosts are our own store", () =>
    ["vercel-storage.com", "abc.private.blob.vercel-storage.com", "ABC.Public.Blob.Vercel-Storage.com", "evilvercel-storage.com", "vercel-storage.com.evil.org", "storage.test", "localhost"].map((h) => [h, safeFetch.isBlobHost(h)]),
  );
  await step("safe-fetch: a store link is flagged", () => {
    const v = safeFetch.validatePdfUrl("https://abc.private.blob.vercel-storage.com/artifacts/r.pdf?sig=x");
    const other = safeFetch.validatePdfUrl("https://www.w3.org/r.pdf");
    return { ok: v.ok, blob: v.blob, other: other.blob };
  });

  /* ---- with no storage configured --------------------------------------------------------------------------- */
  const savedToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const local = mkdtempSync(join(tmpdir(), "storage-default-"));
  try {
    await step("unconfigured: the agent store falls back to local files", async () => {
      const s = store.createDataroomStore({ orgId: A, localRootDir: local });
      await s.write(`${F.accounts}/acme-bank/context.md`, "local\n");
      await s.appendJsonl(`${F.accounts}/acme-bank/interactions.jsonl`, { i: 1 });
      return {
        kind: s.backend.kind,
        list: await s.list(""),
        read: await s.read(`${F.accounts}/acme-bank/interactions.jsonl`),
        downloadUrl: await s.downloadUrl(`${F.accounts}/acme-bank/context.md`),
        onDisk: existsSync(join(local, "orgs", A, `${F.accounts}`, "acme-bank", "context.md")),
      };
    });
    await step("unconfigured: publish_artifact refuses", () => artifact.publishArtifact({ orgId: A, filename: "x.md", content: "x" }));
    await step("unconfigured: web list", () => web.listDataroomPaths(A));
    await step("unconfigured: web read", () => web.readDataroomFile(`${F.accounts}/acme-bank/context.md`, A));
    await step("unconfigured: web stat", () => web.statDataroomObject(`${F.accounts}/acme-bank/context.md`, A));
    await step("unconfigured: web open", () => web.openDataroomObject(`${F.accounts}/acme-bank/context.md`, A));
    await step("unconfigured: web write", () => web.writeDataroomFile(`${F.accounts}/acme-bank/context.md`, "x", undefined, A));
    await step("unconfigured: GET /api/dataroom", () => route("../app/api/dataroom/route.ts", "GET", "http://storage.test/api/dataroom"));
    await step("unconfigured: GET /api/dataroom as=bytes", () => route("../app/api/dataroom/route.ts", "GET", `http://storage.test/api/dataroom?path=${F.uploads}/a/b.pdf&as=bytes`));
    await step("unconfigured: GET /api/ops/dataroom", () => route("../app/api/ops/dataroom/route.ts", "GET", "http://storage.test/api/ops/dataroom"));
    await step("unconfigured: POST /api/ops/dataroom", () => post({ path: `${F.accounts}/new-co/context.md`, content: "x" }));
    await step("unconfigured: POST /api/ops/upload", async () => {
      const form = new FormData();
      form.set("file", new File([Buffer.from("x")], "x.txt", { type: "text/plain" }));
      const handlers = await import("../app/api/ops/upload/route.ts");
      const res = await handlers.POST(new NextRequest("http://storage.test/api/ops/upload", { method: "POST", headers: { authorization: bearer }, body: form }));
      return { status: res.status, body: await res.json() };
    });
    await step("unconfigured: GET /api/ops/artifact-link", () => route("../app/api/ops/artifact-link/route.ts", "GET", "http://storage.test/api/ops/artifact-link?path=artifacts/x.html"));
    await step("unconfigured: GET /api/ops/health", async () => {
      const res = await quietly(() => route("../app/api/ops/health/route.ts", "GET", "http://storage.test/api/ops/health"));
      return { status: res.status, blob: res.body.blob };
    });
  } finally {
    process.env.BLOB_READ_WRITE_TOKEN = savedToken;
    rmSync(local, { recursive: true, force: true });
  }
}

await scenario();

const recording = JSON.parse(JSON.stringify({ calls, wire: blob.wire, fetches, results }));

if (RECORD) {
  mkdirSync(dirname(GOLDEN), { recursive: true });
  // Escaped where a hash or an encoded path happens to spell the retired word (scripts/lib/json-text.mjs); the values are the same.
  writeFileSync(GOLDEN, `${stringifyRecorded(recording, 1)}\n`);
  console.log(`recorded ${recording.calls.length} blob calls, ${recording.wire.length} requests, ${recording.fetches.length} object reads, ${recording.results.length} results -> ${GOLDEN}`);
  process.exit(0);
}

if (!existsSync(GOLDEN)) {
  console.error(`no recording at ${GOLDEN}`);
  process.exit(1);
}
const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));

let failed = 0;
function compare(name, want, got, describe) {
  let firstDiff = -1;
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (JSON.stringify(want[i]) !== JSON.stringify(got[i])) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff === -1) {
    console.log(`  ok   ${name}: ${got.length} identical to the recording made before the driver`);
    return;
  }
  failed++;
  console.log(`  FAIL ${name}: differs at #${firstDiff} (${want.length} recorded, ${got.length} now)`);
  console.log(`       before: ${describe(want[firstDiff])}`);
  console.log(`       now:    ${describe(got[firstDiff])}`);
}
const show = (v) => (v === undefined ? "(nothing)" : JSON.stringify(v).slice(0, 900));

console.log(`Default storage driver, STORAGE_DRIVER=${DRIVER_SETTING}`);
compare("calls into @vercel/blob (operation, key, options)", golden.calls, recording.calls, show);
compare("requests on the wire (method, path, option headers, body digest)", golden.wire, recording.wire, show);
compare("reads of a signed object URL (the URL and the fetch options the app passed)", golden.fetches, recording.fetches, show);
compare("what each entry point returned (paths, contents, URLs, statuses)", golden.results, recording.results, show);
const expected = { calls: 150, wire: 145, fetches: 30, results: 90 };
if (recording.calls.length < expected.calls || recording.wire.length < expected.wire || recording.fetches.length < expected.fetches || recording.results.length < expected.results) {
  failed++;
  console.log(`  FAIL the scenario shrank: ${recording.calls.length} calls, ${recording.wire.length} requests, ${recording.fetches.length} object reads, ${recording.results.length} results`);
}
const ops = [...new Set(recording.calls.map((c) => c.op))].sort();
const wantOps = ["del", "head", "issueSignedToken", "list", "presignUrl", "put"];
if (JSON.stringify(ops) !== JSON.stringify(wantOps)) {
  failed++;
  console.log(`  FAIL the scenario no longer exercises every operation the app uses: ${ops.join(", ")}`);
} else {
  console.log(`  ok   every operation the app uses is exercised: ${ops.join(", ")}`);
}
const errored = recording.results.filter((r) => typeof r.threw === "string" && /fake-blob|not implemented|MockNotMatched|ECONNREFUSED/.test(r.threw));
if (errored.length) {
  failed++;
  console.log(`  FAIL a step failed for a reason of the test rig, not the app: ${show(errored[0])}`);
}

console.log(failed ? `\n${failed} failed` : "\nall identical");
process.exit(failed ? 1 : 0);
