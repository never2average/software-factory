/**
 * THE STORAGE DRIVERS — every driver, driven for real, and every app path over the ones that are not Vercel Blob.
 *
 * lib/storage puts one interface between the application and its file store. The default driver (Vercel Blob) is held
 * to its old behaviour by scripts/test-storage-default-unchanged.mjs. This file is about the NEW behaviour:
 *
 *   1. the setting: unset is Vercel Blob; `filesystem` and `s3` are selected by name; a selected driver that is
 *      missing a setting is an error naming the setting, never a silent fallback to another store;
 *   2. the key rules a path-backed driver enforces (no way out of the root);
 *   3. the contract, on all three drivers with the same data: put, get, head, list (plain string prefix, ascending
 *      order, pages and cursor), delete, overwrite refusal, signed links — and the three give the SAME listings;
 *   4. the filesystem driver's own promises: traversal, symbolic links, atomic writes, one winner for a contested
 *      key, nothing left in tmp/, a 2 MB object streamed intact;
 *   5. the app's signed links for the filesystem driver, and the route that honours them
 *      (app/api/storage/object): tampered, expired, re-pointed, outside the two namespaces, on another driver;
 *   6. WORKSPACE ISOLATION on the filesystem and S3 drivers through the agent's store, the web app's reader/writer
 *      and the route handlers: one workspace cannot read, list or overwrite another's keys, and every object on disk
 *      is under dataroom/orgs/<id>/ or artifacts/orgs/<id>/;
 *   7. the agent and the web app read each other's writes on those drivers (one layout, one set of conventions);
 *   8. the host allow-lists and the health check ask the driver;
 *   9. the S3 signer against the worked examples in Amazon's documentation, and the driver against a server that
 *      verifies every signature (scripts/lib/fake-s3.mjs).
 *
 * No network, no secrets, no database (two real signed-in workspaces over HTTP are scripts/test-storage-isolation-http-db.mjs).
 * It fails on the code before the driver: there is no lib/storage, and STORAGE_DRIVER is ignored.
 *
 *   npm run test:storage-drivers
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync } from "node:crypto";

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
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 500)}`}`);
  }
};
const attempt = async (fn) => {
  try {
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, name: error?.name, message: String(error?.message ?? error) };
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Every regular file under a directory, as paths relative to it. */
const filesUnder = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
        .sort();

const SCRATCH = mkdtempSync(join(tmpdir(), "storage-drivers-"));
const SECRET = "test-signing-secret-0123456789abcdef-not-a-real-one";
const PUBLIC_URL = "https://app.storage.test";
const STORAGE_ENV = ["STORAGE_DRIVER", "STORAGE_FS_ROOT", "STORAGE_SIGNING_SECRET", "STORAGE_PUBLIC_URL", "WEB_ORIGIN", "STORAGE_S3_ENDPOINT", "STORAGE_S3_BUCKET", "STORAGE_S3_REGION", "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY", "STORAGE_S3_ADDRESSING", "BLOB_READ_WRITE_TOKEN", "NEXT_PUBLIC_STORAGE_HOST"];
for (const name of [...STORAGE_ENV, "DATABASE_URL", "POSTGRES_URL", "EVE_API_URL", "NEXT_PUBLIC_EVE_API_URL", "TASK_WORKFLOW_SERVICE_URL", "DATAROOM_DIR"]) delete process.env[name];
/** Replace every storage setting at once, so no test inherits another's. */
function useEnv(settings) {
  for (const name of STORAGE_ENV) delete process.env[name];
  Object.assign(process.env, settings);
}
const fsEnv = (root) => ({ STORAGE_DRIVER: "filesystem", STORAGE_FS_ROOT: root, STORAGE_SIGNING_SECRET: SECRET, STORAGE_PUBLIC_URL: PUBLIC_URL });

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

// The in-memory Vercel Blob store (also routes loopback requests to the real network, for the S3 test server).
const { installFakeBlob } = await import("./lib/fake-blob.mjs");
const blob = installFakeBlob();
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const { startFakeS3 } = await import("./lib/fake-s3.mjs");
const S3_KEYS = { bucket: "store-test-bucket", accessKeyId: "TESTACCESSKEY", secretAccessKey: "test-secret-access-key" };
const s3 = await startFakeS3(S3_KEYS);
const s3Env = () => ({
  STORAGE_DRIVER: "s3",
  STORAGE_S3_ENDPOINT: s3.endpoint,
  STORAGE_S3_BUCKET: S3_KEYS.bucket,
  STORAGE_S3_ACCESS_KEY_ID: S3_KEYS.accessKeyId,
  STORAGE_S3_SECRET_ACCESS_KEY: S3_KEYS.secretAccessKey,
});

const storage = await import("../lib/storage/index.ts");
const settings = await import("../lib/storage/settings.ts");
const keys = await import("../lib/storage/keys.ts");
const links = await import("../lib/storage/signed-url.ts");
const hosts = await import("../lib/storage/hosts.ts");
const s3lib = await import("../lib/storage/s3.ts");
/** The deployment's stored folder names (agent/lib/dataroom-folders.ts): paths are built from them. */
const { FOLDER: F } = await import("../agent/lib/dataroom-folders.ts");

const A = "icici-hfc";
const B = "onfinance-ai";
/** The workspace a signed-in caller resolves to with no database (lib/org-context.ts). */
const C = "org-onfinance";

try {
  /* ---- 1. the setting ------------------------------------------------------------------------------------------ */
  console.log("1. The setting");
  {
    check("STORAGE_DRIVER unset is vercel-blob", storage.storageKind({}) === "vercel-blob");
    check("…and so is an empty value", storage.storageKind({ STORAGE_DRIVER: "" }) === "vercel-blob" && storage.storageKind({ STORAGE_DRIVER: "  " }) === "vercel-blob");
    check("the default driver with no token is 'not configured' (null), not an error", storage.storageDriver({}) === null && storage.storageConfigured({}) === false);
    check("the default driver with a token is the Vercel Blob driver", storage.storageDriver({ BLOB_READ_WRITE_TOKEN: BLOB_TOKEN })?.kind === "vercel-blob");
    check("STORAGE_DRIVER=vercel-blob is the same driver", storage.storageDriver({ STORAGE_DRIVER: "vercel-blob", BLOB_READ_WRITE_TOKEN: BLOB_TOKEN })?.kind === "vercel-blob");
    check("STORAGE_DRIVER=filesystem (and fs) selects the filesystem driver", storage.storageDriver(fsEnv(join(SCRATCH, "sel")))?.kind === "filesystem" && storage.storageKind({ STORAGE_DRIVER: "fs" }) === "filesystem");
    check("…even when a Vercel Blob token is also present (the setting decides, not the token)", storage.storageDriver({ ...fsEnv(join(SCRATCH, "sel")), BLOB_READ_WRITE_TOKEN: BLOB_TOKEN })?.kind === "filesystem");
    check("STORAGE_DRIVER=s3 selects the S3 driver", storage.storageDriver(s3Env())?.kind === "s3");
    const unknown = await attempt(() => storage.storageDriver({ STORAGE_DRIVER: "gcs" }));
    check("an unknown driver name is an error", unknown.threw && unknown.name === "StorageConfigError", unknown);
    for (const [missing, env] of [
      ["STORAGE_FS_ROOT", { ...fsEnv("/x"), STORAGE_FS_ROOT: "" }],
      ["STORAGE_SIGNING_SECRET", { ...fsEnv("/x"), STORAGE_SIGNING_SECRET: "short" }],
      ["STORAGE_PUBLIC_URL", { ...fsEnv("/x"), STORAGE_PUBLIC_URL: "" }],
      ["STORAGE_S3_ENDPOINT", { ...s3Env(), STORAGE_S3_ENDPOINT: "" }],
      ["STORAGE_S3_BUCKET", { ...s3Env(), STORAGE_S3_BUCKET: "" }],
      ["STORAGE_S3_ACCESS_KEY_ID", { ...s3Env(), STORAGE_S3_ACCESS_KEY_ID: "" }],
      ["STORAGE_S3_SECRET_ACCESS_KEY", { ...s3Env(), STORAGE_S3_SECRET_ACCESS_KEY: "" }],
    ]) {
      const r = await attempt(() => storage.storageDriver(env));
      check(`a selected driver without ${missing} is an error naming it (not another store, not null)`, r.threw && r.name === "StorageConfigError" && r.message.includes(missing), r);
      check(`…and the message carries no value`, r.threw && !r.message.includes(SECRET) && !r.message.includes(S3_KEYS.secretAccessKey));
      check(`…and the routes' "is storage configured" answer is no`, storage.storageConfigured(env) === false);
    }
    check("a relative STORAGE_FS_ROOT is refused", (await attempt(() => settings.filesystemSettings({ ...fsEnv("relative/dir") }))).threw);
    check("an http STORAGE_PUBLIC_URL is refused (https, or loopback for local runs)", (await attempt(() => settings.filesystemSettings({ ...fsEnv("/x"), STORAGE_PUBLIC_URL: "http://app.example.com" }))).threw && settings.filesystemSettings({ ...fsEnv("/x"), STORAGE_PUBLIC_URL: "http://127.0.0.1:3000" }).publicUrl === "http://127.0.0.1:3000");
    check("STORAGE_PUBLIC_URL falls back to WEB_ORIGIN", settings.filesystemSettings({ ...fsEnv("/x"), STORAGE_PUBLIC_URL: "", WEB_ORIGIN: "https://web.example.com/" }).publicUrl === "https://web.example.com");
    check("a bucket name that could be a path is refused", (await attempt(() => settings.s3Settings({ ...s3Env(), STORAGE_S3_BUCKET: "a/../b" }))).threw);
  }

  /* ---- 2. key rules --------------------------------------------------------------------------------------------- */
  console.log("\n2. Keys a path-backed driver accepts");
  const BAD_KEYS = ["", "/etc/passwd", "../x", "a/../b", "a/./b", "a//b", "a/", "..", ".", "a\\b", "a/..\\b", "dataroom/orgs/icici-hfc/../onfinance-ai/x.md", "a/\u0000b", "a/b\n", `${"x".repeat(1025)}`, `a/${"y".repeat(241)}`];
  {
    for (const bad of BAD_KEYS) check(`refused: ${JSON.stringify(bad.length > 40 ? `${bad.slice(0, 12)}…(${bad.length})` : bad)}`, keys.isStorageKey(bad) === false);
    for (const good of ["a", "a/b.md", `dataroom/orgs/icici-hfc/${F.uploads}/priya-icici-com/Board Pack (final).pdf`, "dataroom/orgs/personal:acme.com/x.md", "a/b.jsonl.appends/00001790942400000-000000-abababab.part", "a/..b", "a/b..c", "a/.hidden"]) {
      check(`accepted: ${good}`, keys.isStorageKey(good) === true);
    }
    check("a non-string is refused", !keys.isStorageKey(undefined) && !keys.isStorageKey(null) && !keys.isStorageKey(7) && !keys.isStorageKey(["a"]));
    check("a list prefix may end mid-segment or at a slash", eq(keys.assertStoragePrefix("a/b"), { dir: ["a"], partial: "b" }) && eq(keys.assertStoragePrefix("a/b/"), { dir: ["a", "b"], partial: "" }) && eq(keys.assertStoragePrefix(""), { dir: [], partial: "" }));
    for (const bad of ["../", "a/../b", "a/..", "/a", "a//b", "a\\b"]) check(`a list prefix is refused: ${bad}`, (await attempt(() => keys.assertStoragePrefix(bad))).threw);
    check("a random suffix goes before the extension, in the same folder", keys.withSuffix("artifacts/orgs/x/report.final.html", "S") === "artifacts/orgs/x/report.final-S.html" && keys.withSuffix("a/noext", "S") === "a/noext-S" && keys.withSuffix("a/.env", "S") === "a/.env-S");
  }

  /* ---- 3. the contract, on every driver ------------------------------------------------------------------------ */
  const DATASET = [
    "t/a/b.md",
    "t/a/b.md.appends/0001.part",
    "t/a/b.md.appends/0002.part",
    "t/a/bc.md",
    "t/a/b/c.md",
    "t/a/b/d e (1).txt",
    "t/a/B.md",
    "t/a/a+b&c=d.md",
    "t/ab/z.md",
    "t/b/1.md",
    "t/b/10.md",
    "t/b/2.md",
    "t/b/deep/er/est/x.json",
    "t/c.md",
  ];
  const listings = {};
  async function listAll(driver, prefix, limit) {
    const pages = [];
    let cursor;
    do {
      const page = await driver.list({ prefix, cursor, limit });
      pages.push(page.objects.map((o) => o.key));
      if (page.hasMore && !page.cursor) throw new Error("hasMore without a cursor");
      cursor = page.hasMore ? page.cursor : undefined;
      if (pages.length > 100) throw new Error("listing does not end");
    } while (cursor);
    return pages;
  }
  async function contract(name, driver, { suffixes = true, missingHead = true } = {}) {
    console.log(`\n3. The contract: ${name}`);
    check("kind", driver.kind === name);
    for (const key of DATASET) await driver.put(key, `body of ${key}`, { addRandomSuffix: false, allowOverwrite: true, contentType: "text/plain; charset=utf-8" });
    const got = await driver.get("t/a/b/d e (1).txt", { ttlMs: 60_000 });
    check("get returns the bytes", got !== null && got.status === 200 && (await got.text()) === "body of t/a/b/d e (1).txt");
    const typed = await driver.get("t/c.md", { ttlMs: 60_000 });
    check("…and the stored content type", typed?.headers.get("content-type")?.startsWith("text/plain") === true, typed?.headers.get("content-type"));
    await typed?.arrayBuffer();
    check("get of a missing key is null", (await driver.get("t/none.md", { ttlMs: 60_000 })) === null);
    const bytes = Buffer.from([0, 255, 1, 254, 37, 80, 68, 70]);
    await driver.put("t/bin.pdf", bytes, { addRandomSuffix: false, allowOverwrite: true, contentType: "application/pdf" });
    const back = await driver.get("t/bin.pdf", { ttlMs: 60_000 });
    check("bytes round-trip unchanged", back !== null && Buffer.from(await back.arrayBuffer()).equals(bytes));
    check("head reports the size", eq(await driver.head("t/bin.pdf"), { size: 8 }));
    if (missingHead) check("head of a missing key is null", (await driver.head("t/none.pdf")) === null);
    await driver.delete("t/bin.pdf");

    const again = await attempt(() => driver.put("t/c.md", "second", { addRandomSuffix: false, allowOverwrite: false }));
    check("a write over an existing key without allowOverwrite fails", again.threw, again);
    const implicit = await attempt(() => driver.put("t/c.md", "third", { addRandomSuffix: false }));
    check("…and so does one that does not mention allowOverwrite", implicit.threw, implicit);
    check("…and the object is unchanged", (await (await driver.get("t/c.md", { ttlMs: 60_000 })).text()) === "body of t/c.md");
    await driver.put("t/c.md", "replaced", { addRandomSuffix: false, allowOverwrite: true });
    check("with allowOverwrite it is replaced", (await (await driver.get("t/c.md", { ttlMs: 60_000 })).text()) === "replaced");
    await driver.put("t/c.md", "body of t/c.md", { addRandomSuffix: false, allowOverwrite: true });

    if (suffixes) {
      const one = await driver.put("t/s/report.html", "<p>1</p>", { addRandomSuffix: true, contentType: "text/html; charset=utf-8" });
      const two = await driver.put("t/s/report.html", "<p>2</p>", { addRandomSuffix: true, contentType: "text/html; charset=utf-8" });
      check("addRandomSuffix: two writes of one name are two objects", one.key !== two.key && (await (await driver.get(one.key, { ttlMs: 1000 })).text()) === "<p>1</p>" && (await (await driver.get(two.key, { ttlMs: 1000 })).text()) === "<p>2</p>", [one.key, two.key]);
      check("…in the same folder, with the same extension, and an unguessable suffix", [one, two].every((r) => /^t\/s\/report-[A-Za-z0-9]{20}\.html$/.test(r.key)), [one.key, two.key]);
      check("…and head/delete take back the ref put returned", (await driver.head(one.ref))?.size === 8);
      await driver.delete([one.ref, two.ref]);
      check("delete takes an array", (await driver.get(one.key, { ttlMs: 1000 })) === null && (await driver.get(two.key, { ttlMs: 1000 })) === null);
    }
    check("deleting a missing object is not an error", !(await attempt(() => driver.delete("t/never-existed.md"))).threw);

    const sorted = [...DATASET].sort();
    const all = await listAll(driver, "t/", 1000);
    check("list returns every key under a prefix, in ascending order", eq(all.flat(), sorted), all.flat());
    const paged = await listAll(driver, "t/", 4);
    check("pages of 4: the same keys, in the same order, with no gap and no repeat", eq(paged.flat(), sorted) && paged.length === 4 && paged.slice(0, -1).every((p) => p.length === 4), paged.map((p) => p.length));
    const exact = await listAll(driver, "t/", 14);
    check("a listing that fits exactly one page says there is no more", exact.length === 1 && exact[0].length === 14, exact.map((p) => p.length));
    check("a prefix is a plain string prefix, not a folder: 't/a/b' matches b.md, its .appends, bc.md and b/…", eq((await listAll(driver, "t/a/b", 1000)).flat(), sorted.filter((k) => k.startsWith("t/a/b"))) && (await listAll(driver, "t/a/b", 1000)).flat().length === 6);
    check("…the append-part prefix of one file lists only its parts", eq((await listAll(driver, "t/a/b.md.appends/", 1000)).flat(), ["t/a/b.md.appends/0001.part", "t/a/b.md.appends/0002.part"]));
    check("…a full key as the prefix finds that object (the PDF preview's size check)", (await driver.list({ prefix: "t/b/1.md", limit: 1000 })).objects.some((o) => o.key === "t/b/1.md" && o.size === 16));
    check("…'t/a' also matches 't/ab/…' (so callers that want a folder end the prefix with a slash)", (await listAll(driver, "t/a", 1000)).flat().includes("t/ab/z.md") && !(await listAll(driver, "t/a/", 1000)).flat().includes("t/ab/z.md"));
    check("a prefix nothing matches lists nothing", eq(await listAll(driver, "t/zzz", 1000), [[]]) && eq(await listAll(driver, "nowhere/at/all/", 1000), [[]]));
    check("sizes are reported", (await driver.list({ prefix: "t/b/", limit: 1000 })).objects.every((o) => o.size === `body of ${o.key}`.length));
    listings[name] = { all: all.flat(), paged, mid: (await listAll(driver, "t/a/b", 2)), b: await listAll(driver, "t/b/", 2) };
  }

  useEnv({ BLOB_TOKEN });
  blob.reset();
  await contract("vercel-blob", storage.createVercelBlobDriver(BLOB_TOKEN), { suffixes: false, missingHead: false });
  const fsRoot = join(SCRATCH, "contract");
  const fsDriver = storage.storageDriver(fsEnv(fsRoot));
  await contract("filesystem", fsDriver);
  const s3Driver = storage.storageDriver(s3Env());
  await contract("s3", s3Driver);
  console.log("\n3b. The three drivers agree");
  check("the same data lists identically on Vercel Blob, the filesystem and S3 (whole, in pages of 4, and under two prefixes in pages of 2)", eq(listings["vercel-blob"], listings.filesystem) && eq(listings.filesystem, listings.s3), listings);
  check("the S3 server refused no signature (every request was signed for what it sent)", s3.refused() === 0, s3.requests.filter((r) => r.denied).slice(0, 3));

  /* ---- 4. the filesystem driver's own promises ------------------------------------------------------------------ */
  console.log("\n4. The filesystem driver");
  {
    const root = join(SCRATCH, "fs");
    const outside = join(SCRATCH, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "OUTSIDE THE STORE");
    const driver = storage.storageDriver(fsEnv(root));
    await driver.put("dataroom/orgs/a/x.md", "x", { allowOverwrite: true });
    const before = filesUnder(SCRATCH).filter((f) => !f.startsWith("contract/"));
    for (const bad of BAD_KEYS) {
      const results = [
        await attempt(() => driver.put(bad, "pwned", { allowOverwrite: true })),
        await attempt(() => driver.get(bad, { ttlMs: 1000 })),
        await attempt(() => driver.head(bad)),
        await attempt(() => driver.delete(bad)),
        await attempt(() => driver.signedUrl(bad, 1000)),
      ];
      check(`put/get/head/delete/sign refuse ${JSON.stringify(bad.length > 40 ? `${bad.slice(0, 12)}…(${bad.length})` : bad)}`, results.every((r) => r.threw && r.name === "StorageKeyError"), results.filter((r) => !r.threw));
    }
    for (const bad of ["../", "../outside/", "a/../../", "/", "/etc/"]) check(`list refuses the prefix ${bad}`, (await attempt(() => driver.list({ prefix: bad }))).threw);
    check("…and none of it created, changed or removed a file anywhere", eq(filesUnder(SCRATCH).filter((f) => !f.startsWith("contract/")), before) && readFileSync(join(outside, "secret.txt"), "utf8") === "OUTSIDE THE STORE");
    check("objects live under objects/<key>; nothing else is in the root but meta/ and tmp/", eq(readdirSync(root).sort(), ["meta", "objects", "tmp"].filter((d) => existsSync(join(root, d)))) && existsSync(join(root, "objects/dataroom/orgs/a/x.md")));

    // A symbolic link planted inside the store (not something the app can create; a second line of defence).
    symlinkSync(join(outside, "secret.txt"), join(root, "objects/dataroom/orgs/a/link.md"));
    symlinkSync(outside, join(root, "objects/dataroom/orgs/a/linkdir"));
    check("a symbolic link at a key is not an object: get is null", (await driver.get("dataroom/orgs/a/link.md", { ttlMs: 1000 })) === null);
    check("…head is null", (await driver.head("dataroom/orgs/a/link.md")) === null);
    check("…a key THROUGH a linked folder reads nothing", (await driver.get("dataroom/orgs/a/linkdir/secret.txt", { ttlMs: 1000 })) === null && (await driver.head("dataroom/orgs/a/linkdir/secret.txt")) === null);
    check("…a listing does not follow it or report it", eq((await driver.list({ prefix: "dataroom/orgs/a/" })).objects.map((o) => o.key), ["dataroom/orgs/a/x.md"]));
    const through = await attempt(() => driver.put("dataroom/orgs/a/linkdir/planted.txt", "pwned", { allowOverwrite: true }));
    check("…and a write through a linked folder is refused, leaving nothing outside", through.threw && !existsSync(join(outside, "planted.txt")), through);

    await driver.put("dataroom/orgs/a/t.md", "typed", { allowOverwrite: true, contentType: "text/markdown; charset=utf-8" });
    await driver.put("dataroom/orgs/a/t.md", "untyped", { allowOverwrite: true });
    check("an overwrite without a content type does not inherit the old one (falls back to the extension)", (await driver.get("dataroom/orgs/a/t.md", { ttlMs: 1 })).headers.get("content-type") === "text/markdown; charset=utf-8");
    await driver.put("dataroom/orgs/a/t.bin", "x", { allowOverwrite: true, contentType: "application/x-custom" });
    check("a stored content type is returned", (await driver.get("dataroom/orgs/a/t.bin", { ttlMs: 1 })).headers.get("content-type") === "application/x-custom");
    await driver.put("dataroom/orgs/a/t.bin", "x", { allowOverwrite: true, contentType: "text/html\r\nset-cookie: a=b" });
    check("a stored type that is not a plain header value is not sent back", (await driver.get("dataroom/orgs/a/t.bin", { ttlMs: 1 })).headers.get("content-type") === "application/octet-stream");
    await driver.put("dataroom/orgs/a/t.bin", "x", { allowOverwrite: true });
    check("…and gone after an untyped overwrite", (await driver.get("dataroom/orgs/a/t.bin", { ttlMs: 1 })).headers.get("content-type") === "application/octet-stream");

    const contested = await Promise.all(Array.from({ length: 24 }, (_, i) => attempt(() => driver.put("dataroom/orgs/a/contested.part", `writer ${i}\n`, { allowOverwrite: false }))));
    const winners = contested.filter((r) => !r.threw);
    const content = await (await driver.get("dataroom/orgs/a/contested.part", { ttlMs: 1 })).text();
    check("24 concurrent writers of one key without allowOverwrite: exactly one wins", winners.length === 1, winners.length);
    check("…and the object is that writer's whole body", /^writer \d+\n$/.test(content), content);

    const big = Buffer.alloc(2 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255;
    await driver.put("dataroom/orgs/a/big.pdf", big, { allowOverwrite: true, contentType: "application/pdf" });
    const bigBack = await driver.get("dataroom/orgs/a/big.pdf", { ttlMs: 1 });
    check("a 2 MB object streams back intact, with its length", bigBack.headers.get("content-length") === String(big.length) && Buffer.from(await bigBack.arrayBuffer()).equals(big));

    // Readers during overwrites never see a torn object: two bodies of different lengths, each all one character.
    const bodyA = "a".repeat(300_000);
    const bodyB = "b".repeat(700_000);
    await driver.put("dataroom/orgs/a/torn.md", bodyA, { allowOverwrite: true });
    let torn = 0;
    let reads = 0;
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 40; i++) await driver.put("dataroom/orgs/a/torn.md", i % 2 ? bodyA : bodyB, { allowOverwrite: true });
      writing = false;
    })();
    const reader = (async () => {
      while (writing) {
        const text = await (await driver.get("dataroom/orgs/a/torn.md", { ttlMs: 1 })).text();
        reads++;
        if (text !== bodyA && text !== bodyB) torn++;
      }
    })();
    await Promise.all([writer, reader]);
    check(`a reader during 40 overwrites sees a whole object every time (${reads} reads)`, torn === 0 && reads > 0, { torn, reads });
    check("nothing is left in tmp/ after all of that", filesUnder(join(root, "tmp")).length === 0, filesUnder(join(root, "tmp")));
    check("an object's file is not world-readable", (statSync(join(root, "objects/dataroom/orgs/a/x.md")).mode & 0o077) === 0);

    const clash = await attempt(() => driver.put("dataroom/orgs/a/x.md/child.md", "x", { allowOverwrite: true }));
    check("a key under an existing object (a/x.md/child) fails loudly instead of writing elsewhere", clash.threw, clash);
    const bogus = await attempt(() => driver.list({ prefix: "dataroom/", cursor: "not a cursor!" }));
    check("a cursor that is not one of ours is refused", bogus.threw, bogus);
  }

  /* ---- 5. the app's signed links and the route that honours them ------------------------------------------------- */
  console.log("\n5. Signed links on the filesystem driver, and /api/storage/object");
  const { NextRequest } = await import("next/server");
  const objectRoute = await import("../app/api/storage/object/[...key]/route.ts");
  const hit = async (url) => {
    const u = new URL(url);
    const res = await objectRoute.GET(new NextRequest(`http://internal.test${u.pathname}${u.search}`));
    return { status: res.status, type: res.headers.get("content-type"), csp: res.headers.get("content-security-policy"), cache: res.headers.get("cache-control"), sniff: res.headers.get("x-content-type-options"), text: await res.text() };
  };
  {
    const root = join(SCRATCH, "links");
    useEnv(fsEnv(root));
    const driver = storage.storageDriver();
    const KEY_A = `dataroom/orgs/${A}/${F.uploads}/priya-icici-com/Board Pack (final).pdf`;
    const KEY_B = `dataroom/orgs/${B}/${F.uploads}/sam-example-com/notes.md`;
    const ART = `artifacts/orgs/${A}/report.html`;
    await driver.put(KEY_A, "A's board pack", { allowOverwrite: true, contentType: "application/pdf" });
    await driver.put(KEY_B, "B's notes", { allowOverwrite: true });
    await driver.put(ART, "<script>parent.postMessage(localStorage.token,'*')</script>", { allowOverwrite: true, contentType: "text/html; charset=utf-8" });
    await driver.put("_health/probe.txt", "probe", { allowOverwrite: true });

    const signed = await driver.signedUrl(KEY_A, 60_000);
    const u = new URL(signed.url);
    check("a signed link is on the app's own address, under /api/storage/object", u.origin === PUBLIC_URL && u.pathname.startsWith("/api/storage/object/"), signed.url);
    check("…its path ends in the file's name (the console reads the extension from it)", decodeURIComponent(u.pathname.split("/").pop()) === "Board Pack (final).pdf");
    check("…it carries an expiry and a signature, and no secret", u.searchParams.get("exp") === String(signed.expiresAt) && /^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get("sig")) && !signed.url.includes(SECRET));
    check("…expiring when asked", Math.abs(signed.expiresAt - (Date.now() + 60_000)) < 5_000);
    check("the driver's link rules own it, and recover the key from it", driver.urls.ownsUrl(u) && driver.urls.keyFromUrl(signed.url) === KEY_A);
    check("…and own nothing else: another host, another path, the same path over http", !driver.urls.ownsUrl(new URL(signed.url.replace("app.storage.test", "evil.test"))) && !driver.urls.ownsUrl(new URL(`${PUBLIC_URL}/api/ops/health`)) && !driver.urls.ownsUrl(new URL(signed.url.replace("https://", "http://"))) && driver.urls.keyFromUrl("https://abc.private.blob.vercel-storage.com/artifacts/x.html") === null);

    const ok = await hit(signed.url);
    check("GET with a valid link serves the object", ok.status === 200 && ok.text === "A's board pack" && ok.type === "application/pdf", ok);
    check("…declared and not sniffed, never cached by a shared cache", ok.sniff === "nosniff" && /private/.test(ok.cache) && /no-store/.test(ok.cache), ok);
    check("…a PDF is the one type served without the sandbox (a browser will not draw one inside it)", ok.csp === null, ok.csp);
    await driver.put(`dataroom/orgs/${A}/${F.uploads}/x/evil.pdf`, "<script>alert(1)</script>", { allowOverwrite: true, contentType: "text/html" });
    await driver.put(`dataroom/orgs/${A}/${F.uploads}/x/pic.svg`, "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", { allowOverwrite: true });
    await driver.put(`dataroom/orgs/${A}/${F.uploads}/x/unknown.bin`, "<script>alert(1)</script>", { allowOverwrite: true });
    await driver.put(`dataroom/orgs/${A}/${F.uploads}/x/odd.pdf`, "<script>alert(1)</script>", { allowOverwrite: true, contentType: "Application/PDF; x=<html>" });
    const served = {};
    for (const name of ["evil.pdf", "pic.svg", "unknown.bin", "odd.pdf"]) served[name] = await hit((await driver.signedUrl(`dataroom/orgs/${A}/${F.uploads}/x/${name}`, 60_000)).url);
    check("an upload DECLARED as HTML is sandboxed whatever its name", served["evil.pdf"].type === "text/html" && served["evil.pdf"].csp === "sandbox allow-scripts", served["evil.pdf"]);
    check("…and so are an SVG and an unknown type", served["pic.svg"].csp === "sandbox allow-scripts" && served["unknown.bin"].csp === "sandbox allow-scripts" && served["unknown.bin"].type === "application/octet-stream", [served["pic.svg"].csp, served["unknown.bin"].csp]);
    check("…and every one of them is nosniff, so a body that looks like HTML is not treated as HTML", Object.values(served).every((r) => r.sniff === "nosniff"));
    const html = await hit((await driver.signedUrl(ART, 60_000)).url);
    check("a model-written HTML artifact is served sandboxed too (no access to this site's storage)", html.status === 200 && html.type.startsWith("text/html") && html.csp === "sandbox allow-scripts", html);

    const refusedAll = [];
    const refuse = async (label, url, want = 403) => {
      const r = await hit(url);
      refusedAll.push(r);
      check(`${label} → ${want}`, r.status === want && !r.text.includes("board pack") && !r.text.includes("B's notes"), r);
    };
    await refuse("no signature", `${PUBLIC_URL}${u.pathname}`);
    await refuse("no expiry", `${PUBLIC_URL}${u.pathname}?sig=${u.searchParams.get("sig")}`);
    await refuse("a wrong signature", signed.url.replace(/sig=.{6}/, "sig=AAAAAA"));
    await refuse("a later expiry with the old signature", signed.url.replace(/exp=\d+/, `exp=${signed.expiresAt + 1}`));
    await refuse("A's signature on B's key", `${PUBLIC_URL}/api/storage/object/${KEY_B.split("/").map(encodeURIComponent).join("/")}${u.search}`);
    await refuse("an expired link", (await driver.signedUrl(KEY_A, -1)).url);
    await refuse("an expiry that is not a number", signed.url.replace(/exp=\d+/, "exp=1e99"));
    const forged = (key, exp = Date.now() + 60_000) => links.signObjectUrl({ publicUrl: PUBLIC_URL, secret: SECRET, key, expiresAt: exp });
    await refuse("a correctly signed link for the health probe (not a workspace's file)", forged("_health/probe.txt"));
    await refuse("…for a key outside any workspace", forged("dataroom/secret.md"));
    await refuse("…for a key with a dot segment", forged(`dataroom/orgs/${A}/../${B}/${F.uploads}/sam-example-com/notes.md`));
    await refuse("…signed with another secret", links.signObjectUrl({ publicUrl: PUBLIC_URL, secret: "another-secret-another-secret-another!", key: KEY_A, expiresAt: Date.now() + 60_000 }));
    await refuse("a percent-encoded slash in a segment (a different key than the one signed)", signed.url.replace(`/${F.uploads}/`, `/${F.uploads}%2F`));
    const gone = await hit(forged(`dataroom/orgs/${A}/${F.uploads}/none.pdf`));
    check("a valid link to a missing object → 404", gone.status === 404, gone);
    const dir = await hit(forged(`dataroom/orgs/${A}/${F.uploads}`));
    check("a valid link to a FOLDER serves nothing (no directory listing)", dir.status === 404, dir);
    check("the driver itself will not sign a key outside the two namespaces", (await attempt(() => driver.signedUrl("_health/probe.txt", 1000))).threw && (await attempt(() => driver.signedUrl("dataroom/x.md", 1000))).threw && (await attempt(() => driver.signedUrl(`other/orgs/${A}/x.md`, 1000))).threw);
    check("following a link without the network gives the same answers", (await driver.urls.open(u)).status === 200 && (await driver.urls.open(new URL(signed.url.replace(/sig=.{6}/, "sig=AAAAAA")))).status === 403 && (await driver.urls.open(new URL(forged(`dataroom/orgs/${A}/${F.uploads}/none.pdf`)))).status === 404);

    useEnv({ BLOB_READ_WRITE_TOKEN: BLOB_TOKEN });
    check("on the default driver the route serves nothing (404), valid link or not", (await hit(signed.url)).status === 404);
    useEnv(s3Env());
    check("…and on the S3 driver", (await hit(signed.url)).status === 404);
    useEnv({ ...fsEnv(root), STORAGE_SIGNING_SECRET: "" });
    check("…and when the filesystem driver is missing a setting", (await hit(signed.url)).status === 404);
    useEnv({ ...fsEnv(root), STORAGE_SIGNING_SECRET: "a-different-deployment-secret-0123456789" });
    check("a link signed under another secret is refused after rotation", (await hit(signed.url)).status === 403);
  }

  /* ---- 6 + 7. workspace isolation and agent/web agreement, per driver -------------------------------------------- */
  const store = await import("../agent/lib/dataroom-store.ts");
  const web = await import("../lib/dataroom-blob.ts");
  const artifact = await import("../agent/lib/artifact.ts");
  const { mintSessionToken } = await import("../lib/auth-session.ts");
  const bearer = `Bearer ${await mintSessionToken("reader@onfinance.in")}`;
  const call = async (mod, method, url, init = {}) => {
    const handlers = await import(mod);
    const res = await handlers[method](new NextRequest(url, { method, headers: { authorization: bearer, ...(init.headers ?? {}) }, body: init.body }));
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, body, text, type: res.headers.get("content-type") };
  };
  const quietly = async (fn) => {
    const saved = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = saved;
    }
  };

  async function appSuite(kind, env, allKeys, rawRead) {
    console.log(`\n6. Workspace isolation through the app, ${kind} driver`);
    useEnv(env);
    const a = store.createDataroomStore({ orgId: A });
    const b = store.createDataroomStore({ orgId: B });
    check(`the agent's store is on the ${kind} driver (not its local scratch tree, not another driver)`, a.backend.kind === kind, a.backend.kind);
    const A_FILES = [`${F.accounts}/acme-bank/context.md`, `${F.uploads}/priya-icici-com/board-pack.pdf`];
    const A_JSONL = `${F.accounts}/acme-bank/interactions.jsonl`;
    for (const path of A_FILES) await a.write(path, `A's ${path}\n`);
    await a.appendJsonl(A_JSONL, [{ interactionId: "INT-1", note: "A only" }]);
    await a.appendJsonl(A_JSONL, [{ interactionId: "INT-2", note: "A only" }]);

    // -- the agent's store
    const bList = await b.list("");
    check("agent: workspace B lists none of A's files", bList.length === 0, bList);
    check("agent: …nor under a prefix", (await b.list(`${F.accounts}`)).length === 0 && (await b.list(`${F.uploads}`)).length === 0);
    check("agent: B reads none of A's files at the same paths", (await Promise.all([...A_FILES, A_JSONL].map((p) => b.read(p)))).every((v) => v === null));
    check("agent: …nor their bytes", (await b.readBytes(A_FILES[1])) === null);
    const bUrl = await b.downloadUrl(A_FILES[1]);
    check("agent: B's download link for that path names B's own key, never A's", bUrl !== null && !bUrl.includes(`/orgs/${A}/`) && bUrl.includes(`/orgs/${B}/`), bUrl);
    const viaBLink = await storage.storageUrlRules().open(new URL(bUrl));
    check("agent: …and following it finds nothing", viaBLink.status === 404, viaBLink.status);
    await viaBLink.arrayBuffer().catch(() => undefined);
    for (const reach of [`orgs/${A}/${A_FILES[0]}`, `../${A}/${A_FILES[0]}`, `${F.accounts}/../../${A}/${A_FILES[0]}`, `/${A_FILES[0]}`, `${F.accounts}\\..\\..\\${A}`]) {
      const r = await attempt(() => b.read(reach));
      const w = await attempt(() => b.write(reach, "pwned by B\n"));
      const l = await attempt(() => b.list(reach));
      check(`agent: B cannot read, write or list through ${JSON.stringify(reach)}`, (r.threw || r.value === null) && w.threw && (l.threw || l.value.length === 0), { r, w, l });
    }
    await b.write(A_FILES[0], "B's own file at the same path\n");
    await b.appendJsonl(A_JSONL, [{ interactionId: "B-1", note: "B only" }]);
    check("agent: B writing the SAME path writes B's file; A's is unchanged", (await a.read(A_FILES[0])) === `A's ${A_FILES[0]}\n` && (await b.read(A_FILES[0])) === "B's own file at the same path\n");
    check("agent: …and B's append lands in B's file only", !(await a.read(A_JSONL)).includes("B only") && !(await b.read(A_JSONL)).includes("A only"));
    check("agent: A lists exactly its own three files", eq(await a.list(""), [A_FILES[0], A_JSONL, A_FILES[1]].sort()), await a.list(""));
    for (const bad of [undefined, null, "", "  ", "../icici-hfc", "orgs/icici-hfc", "a/b", ".."]) {
      const r = await attempt(async () => (await store.createDataroomStore({ orgId: bad })).list(""));
      check(`agent: workspace id ${JSON.stringify(bad)} is refused`, r.threw, r);
    }

    // -- the web app's reader/writer
    check("web: B's listing has only B's files", eq(await web.listDataroomPaths(B), [A_FILES[0], A_JSONL].sort()), await web.listDataroomPaths(B));
    check("web: B reads its own file at A's path, not A's", (await web.readDataroomFile(A_FILES[0], B)) === "B's own file at the same path\n");
    check("web: B reads nothing where only A has a file", (await web.readDataroomFile(A_FILES[1], B)) === null && (await web.statDataroomObject(A_FILES[1], B)) === null && (await web.openDataroomObject(A_FILES[1], B)) === null);
    await web.writeDataroomFile(A_FILES[1], Buffer.from("B's pdf"), "application/pdf", B);
    check("web: B's write at A's path lands in B's tree; A's bytes are unchanged", Buffer.from(await a.readBytes(A_FILES[1])).toString() === `A's ${A_FILES[1]}\n` && Buffer.from(await b.readBytes(A_FILES[1])).toString() === "B's pdf");
    const snapA = `_versions/${A}/1700000000000-${F.accounts}/acme-bank/context.md`;
    await web.writeSnapshotObject(snapA, "A's previous bytes\n", A);
    check("web: B cannot read or write A's snapshot", (await attempt(() => web.readSnapshotObject(snapA, B))).threw && (await attempt(() => web.writeSnapshotObject(snapA, "pwned", B))).threw && (await web.readSnapshotObject(snapA, A)) === "A's previous bytes\n");
    for (const [label, fn] of [
      ["listDataroomPaths()", () => web.listDataroomPaths()],
      ["readDataroomFile(path)", () => web.readDataroomFile(A_FILES[0])],
      ["writeDataroomFile(path, body)", () => web.writeDataroomFile(`${F.uploads}/x/y.txt`, "y")],
      ["statDataroomObject(path)", () => web.statDataroomObject(A_FILES[1])],
      ["openDataroomObject(path)", () => web.openDataroomObject(A_FILES[1])],
    ]) {
      check(`web: ${label} with no workspace is refused`, (await attempt(fn)).threw);
    }

    // -- the agent and the web app agree
    console.log(`\n7. One layout, read from both sides, ${kind} driver`);
    check("the web app reads the agent's base + append parts, stitched in order", (await web.readDataroomFile(A_JSONL, A)) === '{"interactionId":"INT-1","note":"A only"}\n{"interactionId":"INT-2","note":"A only"}\n', await web.readDataroomFile(A_JSONL, A));
    check("…and lists the logical path once, with no part files", eq(await web.listDataroomPaths(A), await a.list("")));
    await web.writeDataroomFile(`${F.accounts}/acme-bank/personas.jsonl`, '{"p":1}\n', undefined, A);
    check("the agent reads what the web app wrote", eq(await a.readJsonl(`${F.accounts}/acme-bank/personas.jsonl`), [{ p: 1 }]));
    check("the PDF preview's size check finds the agent's file", eq(await web.statDataroomObject(A_FILES[1], A), { size: `A's ${A_FILES[1]}\n`.length }));
    const opened = await web.openDataroomObject(A_FILES[1], A);
    check("…and its bytes", opened !== null && (await opened.text()) === `A's ${A_FILES[1]}\n`);
    await a.write(A_JSONL, '{"interactionId":"INT-9"}\n');
    check("an overwrite retires the append parts on this driver too", (await web.readDataroomFile(A_JSONL, A)) === '{"interactionId":"INT-9"}\n' && !(await allKeys()).some((k) => k.includes(`${A}/${A_JSONL}.appends/`)), (await allKeys()).filter((k) => k.includes(".appends/")));

    // -- artifacts
    const published = await artifact.publishArtifact({ orgId: A, filename: "status-report.html", content: "<h1>A's report</h1>" });
    const mine = await artifact.publishArtifact({ orgId: C, filename: "own.html", content: "<h1>C's report</h1>" });
    // (The in-memory Vercel Blob store does not add the suffix; Vercel's does.)
    const suffixed = kind === "vercel-blob" ? new RegExp(`^artifacts/orgs/${A}/status-report`) : new RegExp(`^artifacts/orgs/${A}/status-report-[A-Za-z0-9]{20}\\.html$`);
    check("a published artifact is filed under its workspace, with an unguessable suffix", suffixed.test(published.pathname), published.pathname);
    check("…its link is the driver's, and names that key", storage.storageUrlRules().keyFromUrl(published.url) === published.pathname, published.url);
    const traversal = await attempt(() => artifact.publishArtifact({ orgId: A, filename: `../../${B}/planted.html`, content: "pwned" }));
    if (kind === "vercel-blob") {
      // Vercel Blob keys are opaque strings in a flat store, and this driver must make today's calls unchanged: the
      // name is stored literally, still inside A's prefix, so B's tree is untouched (the console's link route refuses
      // a dot segment before signing). The path-backed drivers refuse it outright (below).
      check("an artifact file name with a dot segment stays a key inside its own workspace's prefix", !traversal.threw && traversal.value.pathname.startsWith(`artifacts/orgs/${A}/`) && !(await allKeys()).some((k) => k.startsWith(`artifacts/orgs/${B}/`)), traversal);
      for (const k of await allKeys()) if (k.includes("planted")) blob.objects.delete(k);
    } else {
      check("an artifact file name with a dot segment cannot be published into another workspace", traversal.threw && !(await allKeys()).some((k) => k.includes("planted")), traversal);
    }

    // -- the routes, as a signed-in caller of workspace C
    console.log(`\n6b. The routes as a signed-in caller (workspace ${C}), ${kind} driver`);
    const cStore = store.createDataroomStore({ orgId: C });
    await cStore.write(`${F.uploads}/reader-onfinance-in/mine.md`, "C's own\n");
    const leaks = (r) => [A, B, "A's", "B's", "A only", "B only"].filter((s) => r.text.includes(s));
    const list = await call("../app/api/dataroom/route.ts", "GET", "http://storage.test/api/dataroom");
    check("GET /api/dataroom lists the caller's files and nothing of A's or B's", list.status === 200 && eq(list.body.paths, [`${F.uploads}/reader-onfinance-in/mine.md`]), list.body);
    for (const prefix of ["", "orgs", `orgs/${A}`, `../${A}`, `${F.accounts}`]) {
      const r = await call("../app/api/ops/dataroom/route.ts", "GET", `http://storage.test/api/ops/dataroom?prefix=${encodeURIComponent(prefix)}`);
      check(`GET /api/ops/dataroom?prefix=${prefix} shows nothing of another workspace`, r.status === 200 && leaks(r).length === 0 && r.body.paths.every((p) => p.startsWith(`${F.uploads}/reader-onfinance-in/`)), r.body);
    }
    const REACH = [`orgs/${A}/${A_FILES[0]}`, `../${A}/${A_FILES[0]}`, `${F.accounts}/../../${A}/${A_FILES[0]}`, `${F.accounts}/%2e%2e/%2e%2e/${A}/${A_FILES[0]}`, `/${A_FILES[0]}`, `_versions/${A}/1700000000000-${F.accounts}/acme-bank/context.md`];
    for (const reach of REACH) {
      const q = encodeURIComponent(reach);
      const reads = [
        await call("../app/api/dataroom/route.ts", "GET", `http://storage.test/api/dataroom?path=${q}`),
        await call("../app/api/dataroom/route.ts", "GET", `http://storage.test/api/dataroom?path=${q}&as=bytes`),
        await call("../app/api/ops/dataroom/route.ts", "GET", `http://storage.test/api/ops/dataroom?path=${q}`),
      ];
      const write = await quietly(() => call("../app/api/ops/dataroom/route.ts", "POST", "http://storage.test/api/ops/dataroom", { headers: { "content-type": "application/json" }, body: JSON.stringify({ path: reach, content: "pwned by C\n" }) }));
      check(`read and write through ${JSON.stringify(reach)} are refused (400), and show nothing`, reads.every((r) => r.status === 400 && leaks(r).length === 0) && write.status === 400, { reads: reads.map((r) => r.status), write: write.status });
    }
    for (const path of A_FILES) {
      const r = await call("../app/api/dataroom/route.ts", "GET", `http://storage.test/api/dataroom?path=${encodeURIComponent(path)}`);
      check(`GET /api/dataroom?path=${path} (a path A has) finds nothing for the caller`, r.status === 200 && r.body.found === false && leaks(r).length === 0, r.body);
    }
    const bytes = await call("../app/api/dataroom/route.ts", "GET", `http://storage.test/api/dataroom?path=${encodeURIComponent(A_FILES[1])}&as=bytes`);
    check("…nor its bytes (the PDF viewer)", bytes.status === 404 && leaks(bytes).length === 0, bytes);
    const over = await quietly(() => call("../app/api/ops/dataroom/route.ts", "POST", "http://storage.test/api/ops/dataroom", { headers: { "content-type": "application/json" }, body: JSON.stringify({ path: A_FILES[0], content: "C's file at A's path\n" }) }));
    check("POST /api/ops/dataroom at A's path writes the caller's own file; A's and B's are unchanged", over.status === 200 && (await a.read(A_FILES[0])) === `A's ${A_FILES[0]}\n` && (await b.read(A_FILES[0])) === "B's own file at the same path\n" && (await cStore.read(A_FILES[0])) === "C's file at A's path\n", over);
    const form = new FormData();
    form.set("file", new File([Buffer.from("%PDF-1.7 uploaded by C")], `../../icici-hfc/${F.uploads}/evil.pdf`, { type: "application/pdf" }));
    const uploadRoute = await import("../app/api/ops/upload/route.ts");
    const up = await uploadRoute.POST(new NextRequest("http://storage.test/api/ops/upload", { method: "POST", headers: { authorization: bearer }, body: form }));
    const upBody = await up.json();
    check(`POST /api/ops/upload with a traversal file name lands in the caller's own ${F.uploads} folder`, up.status === 200 && upBody.path === `${F.uploads}/reader-onfinance-in/evil.pdf` && Buffer.from(await cStore.readBytes(upBody.path)).toString() === "%PDF-1.7 uploaded by C", upBody);
    const viewer = await call("../app/api/dataroom/route.ts", "GET", `http://storage.test/api/dataroom?path=${encodeURIComponent(upBody.path)}&as=bytes`);
    check("…and the PDF viewer reads it back", viewer.status === 200 && viewer.text === "%PDF-1.7 uploaded by C" && viewer.type === "application/pdf", { status: viewer.status, type: viewer.type });

    const foreign = await call("../app/api/ops/artifact-link/route.ts", "GET", `http://storage.test/api/ops/artifact-link?path=${encodeURIComponent(published.pathname)}`);
    check("the artifact link refuses another workspace's artifact by path (404, no link)", foreign.status === 404 && !foreign.text.includes("url"), foreign.body);
    const foreignUrl = await call("../app/api/ops/artifact-link/route.ts", "GET", `http://storage.test/api/ops/artifact-link?url=${encodeURIComponent(published.url)}`);
    check("…and by its published link", foreignUrl.status === 404, foreignUrl.body);
    for (const path of [`artifacts//orgs/${A}/x.html`, `artifacts/./orgs/${A}/x.html`, `artifacts/orgs/${C}/../${A}/x.html`, `dataroom/orgs/${A}/${A_FILES[0]}`, `dataroom/orgs/${C}/${F.uploads}/reader-onfinance-in/mine.md`]) {
      const r = await call("../app/api/ops/artifact-link/route.ts", "GET", `http://storage.test/api/ops/artifact-link?path=${encodeURIComponent(path)}`);
      check(`…and signs nothing for ${path}`, r.status >= 400 && !r.body?.url, r.body);
    }
    const own = await call("../app/api/ops/artifact-link/route.ts", "GET", `http://storage.test/api/ops/artifact-link?url=${encodeURIComponent(mine.url)}`);
    check("the caller's own artifact gets a fresh link from its published one", own.status === 200 && own.body.path === mine.pathname && storage.storageUrlRules().keyFromUrl(own.body.url) === mine.pathname, own.body);
    const proxied = await call("../app/api/artifact-proxy/route.ts", "GET", `http://storage.test${own.body?.proxyUrl ?? "/api/artifact-proxy"}`);
    check("…which the artifact proxy follows, with the stored content type", proxied.status === 200 && proxied.text === "<h1>C's report</h1>" && proxied.type?.startsWith("text/html"), { status: proxied.status, type: proxied.type });
    // The signature on a Vercel Blob link is checked by Vercel's own store, which the in-memory fake does not imitate.
    if (kind !== "vercel-blob") {
    const tampered = await call("../app/api/artifact-proxy/route.ts", "GET", `http://storage.test/api/artifact-proxy?url=${encodeURIComponent((own.body?.url ?? "").replace(/(sig|X-Amz-Signature)=.{6}/, "$1=AAAAAA"))}`);
    check("the proxy reports a tampered link as expired (403), with no bytes", tampered.status === 403 && tampered.body?.expired === true, tampered.body);
    }
    for (const other of [...(kind === "vercel-blob" ? [] : ["https://abc.private.blob.vercel-storage.com/artifacts/x.html"]), "https://example.org/a.html", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", `${PUBLIC_URL}/api/ops/health`]) {
      const r = await call("../app/api/artifact-proxy/route.ts", "GET", `http://storage.test/api/artifact-proxy?url=${encodeURIComponent(other)}`);
      check(`the proxy will not follow ${other} on this driver`, r.status === 400, r.status);
    }

    // -- the health probe
    const before = (await allKeys()).length;
    const health = await quietly(() => call("../app/api/ops/health/route.ts", "GET", "http://storage.test/api/ops/health"));
    check(`the health check probes THIS driver (write, head, delete) and says so`, health.body?.blob?.ok === true && health.body.blob.detail === (kind === "vercel-blob" ? "write → head → delete ok" : `write → head → delete ok (${kind})`), health.body?.blob);
    check("…and leaves nothing behind", (await allKeys()).length === before && !(await allKeys()).some((k) => k.startsWith("_health/")));

    // -- where everything ended up
    const everything = await allKeys();
    const stray = everything.filter((k) => !/^(dataroom|artifacts)\/orgs\/[^/]+\/.+/.test(k));
    check("every object is under dataroom/orgs/<workspace>/ or artifacts/orgs/<workspace>/ — nothing at a root", everything.length > 8 && stray.length === 0, stray);
    const owners = new Set(everything.map((k) => k.split("/")[2]));
    check("…and only the three workspaces that wrote have a tree", eq([...owners].sort(), [A, B, C].sort()), [...owners]);
    check("no object of A's holds anything B or C wrote, read straight from the store", (await Promise.all(everything.filter((k) => k.includes(`/orgs/${A}/`)).map((k) => rawRead(k)))).every((text) => !/B's|C's|pwned|B only/.test(text)));
    if (kind !== "vercel-blob") check("nothing was written to Vercel Blob", blob.keys().length === 0, blob.keys());
  }

  blob.reset();
  const appRoot = join(SCRATCH, "app");
  await appSuite("filesystem", fsEnv(appRoot), async () => filesUnder(join(appRoot, "objects")), async (k) => readFileSync(join(appRoot, "objects", k), "utf8"));
  check("filesystem: nothing is left in tmp/", filesUnder(join(appRoot, "tmp")).length === 0);
  check("filesystem: the agent's local scratch tree (.dataroom) was not used", !existsSync(join(appRoot, "orgs")) && !existsSync(join(process.cwd(), ".dataroom", "orgs", A, `${F.accounts}`, "acme-bank", "context.md")));
  s3.objects.clear();
  await appSuite("s3", s3Env(), async () => s3.keys(), async (k) => s3.objects.get(k).body.toString("utf8"));
  check("s3: every request the app made was correctly signed", s3.refused() === 1, s3.requests.filter((r) => r.denied));
  // The same workspace-isolation suite on the DEFAULT driver (the in-memory Vercel Blob store), so every driver is held
  // to it, not only the new ones.
  blob.reset();
  await appSuite("vercel-blob", { BLOB_READ_WRITE_TOKEN: BLOB_TOKEN }, async () => blob.keys(), async (k) => blob.objects.get(k).body.toString("utf8"));
  blob.reset();

  /* ---- 6c. a selected driver that is misconfigured is never mistaken for "no storage" ---------------------------- */
  console.log("\n6c. A misconfigured driver");
  {
    useEnv({ STORAGE_DRIVER: "filesystem", BLOB_READ_WRITE_TOKEN: BLOB_TOKEN });
    const agentStore = await attempt(() => store.createDataroomStore({ orgId: A }));
    check("the agent does NOT fall back to its local scratch tree or to Vercel Blob: it throws, naming the setting", agentStore.threw && agentStore.name === "StorageConfigError" && agentStore.message.includes("STORAGE_FS_ROOT"), agentStore);
    const pub = await attempt(() => artifact.publishArtifact({ orgId: A, filename: "x.html", content: "x" }));
    check("publish_artifact fails the same way", pub.threw && pub.name === "StorageConfigError", pub);
    const list = await call("../app/api/ops/dataroom/route.ts", "GET", "http://storage.test/api/ops/dataroom");
    check("the routes answer 'storage is not configured' (503)", list.status === 503, list);
    const health = await quietly(() => call("../app/api/ops/health/route.ts", "GET", "http://storage.test/api/ops/health"));
    check("the health check names the missing setting", health.body?.blob?.ok === false && health.body.blob.detail.includes("STORAGE_FS_ROOT"), health.body?.blob);
    check("…and nothing was written to Vercel Blob", blob.keys().length === 0);
  }

  /* ---- 8. host allow-lists ask the driver ----------------------------------------------------------------------- */
  console.log("\n8. Which hosts are the store's");
  {
    const safeFetch = await import("../lib/safe-fetch.ts");
    useEnv({});
    check("default: the Vercel Blob hosts, and only those", safeFetch.isBlobHost("abc.private.blob.vercel-storage.com") && safeFetch.isBlobHost("VERCEL-STORAGE.com") && !safeFetch.isBlobHost("evilvercel-storage.com") && !safeFetch.isBlobHost("app.storage.test"));
    check("default: the proxy's rule is https on that host", storage.storageUrlRules().ownsUrl(new URL("https://x.blob.vercel-storage.com/a")) && !storage.storageUrlRules().ownsUrl(new URL("http://x.blob.vercel-storage.com/a")));
    useEnv(fsEnv(join(SCRATCH, "hosts")));
    check("filesystem: the app's own host, and NOT the Vercel Blob host", safeFetch.isBlobHost("app.storage.test") && safeFetch.isBlobHost("APP.storage.test") && !safeFetch.isBlobHost("abc.private.blob.vercel-storage.com"));
    // (A `.test` name is refused outright by the PDF fetcher, so this one check uses a public-looking address.)
    useEnv({ ...fsEnv(join(SCRATCH, "hosts")), STORAGE_PUBLIC_URL: "https://app.example.com" });
    check("filesystem: a store link is flagged as ours by the PDF fetcher", safeFetch.validatePdfUrl("https://app.example.com/api/storage/object/artifacts/orgs/x/r.pdf?exp=1&sig=x").blob === true && safeFetch.validatePdfUrl("https://abc.private.blob.vercel-storage.com/artifacts/r.pdf").blob === false);
    useEnv({ ...s3Env(), STORAGE_S3_ENDPOINT: "https://blr1.digitaloceanspaces.com" });
    check("s3 (path style): the endpoint's host", safeFetch.isBlobHost("blr1.digitaloceanspaces.com") && !safeFetch.isBlobHost("abc.private.blob.vercel-storage.com") && !safeFetch.isBlobHost("evil.digitaloceanspaces.com"));
    const pathRules = storage.storageUrlRules();
    check("s3 (path style): only this bucket's path on that host", pathRules.ownsUrl(new URL("https://blr1.digitaloceanspaces.com/store-test-bucket/artifacts/x.html")) && !pathRules.ownsUrl(new URL("https://blr1.digitaloceanspaces.com/another-bucket/artifacts/x.html")) && !pathRules.ownsUrl(new URL("https://blr1.digitaloceanspaces.com/store-test-bucket-2/x")) && !pathRules.ownsUrl(new URL("https://blr1.digitaloceanspaces.com/store-test-bucket/")));
    check("s3 (path style): the key is the path after the bucket; a dot segment or encoded slash is refused", pathRules.keyFromUrl("https://blr1.digitaloceanspaces.com/store-test-bucket/artifacts/orgs/a/My%20Report.html?X-Amz-Signature=z") === "artifacts/orgs/a/My Report.html" && pathRules.keyFromUrl("https://blr1.digitaloceanspaces.com/store-test-bucket/artifacts/orgs/a%2F..%2Fb/x.html") === null && pathRules.keyFromUrl("https://blr1.digitaloceanspaces.com/other/artifacts/x.html") === null);
    useEnv({ ...s3Env(), STORAGE_S3_ENDPOINT: "https://blr1.digitaloceanspaces.com", STORAGE_S3_ADDRESSING: "virtual" });
    const virtual = storage.storageUrlRules();
    check("s3 (virtual-hosted): the bucket's own host", safeFetch.isBlobHost("store-test-bucket.blr1.digitaloceanspaces.com") && !safeFetch.isBlobHost("blr1.digitaloceanspaces.com") && virtual.keyFromUrl("https://store-test-bucket.blr1.digitaloceanspaces.com/artifacts/orgs/a/x.html") === "artifacts/orgs/a/x.html");
    useEnv({ STORAGE_DRIVER: "filesystem" });
    check("a misconfigured driver owns no host (and does not throw)", safeFetch.isBlobHost("app.storage.test") === false && safeFetch.isBlobHost("abc.private.blob.vercel-storage.com") === false);
    check("browser: with nothing set, the Vercel Blob rule", hosts.isStorageHostForBrowser("abc.private.blob.vercel-storage.com", null) && !hosts.isStorageHostForBrowser("example.org", null));
    check("browser: NEXT_PUBLIC_STORAGE_HOST names the store's hosts instead", hosts.isStorageHostForBrowser("Blr1.DigitalOceanSpaces.com", hosts.publicStorageHosts(" blr1.digitaloceanspaces.com , cdn.example.com ")) && hosts.isStorageHostForBrowser("cdn.example.com", hosts.publicStorageHosts("blr1.digitaloceanspaces.com,cdn.example.com")) && !hosts.isStorageHostForBrowser("abc.private.blob.vercel-storage.com", hosts.publicStorageHosts("blr1.digitaloceanspaces.com")) && hosts.publicStorageHosts("") === null && hosts.publicStorageHosts(" , ") === null);
  }

  /* ---- 9. the S3 signer, against Amazon's own numbers ------------------------------------------------------------ */
  console.log("\n9. AWS Signature V4, against the worked examples in the S3 documentation");
  {
    // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html and sigv4-query-string-auth.html
    const c = { region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", at: new Date(Date.UTC(2013, 4, 24)) };
    const host = "examplebucket.s3.amazonaws.com";
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const common = { host, "x-amz-content-sha256": empty, "x-amz-date": "20130524T000000Z" };
    check("GET object", s3lib.sigV4({ method: "GET", path: "/test.txt", headers: { ...common, range: "bytes=0-9" }, payloadHash: empty, ...c }).signature === "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    const putHash = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
    check("PUT object (a `$` in the key)", s3lib.sigV4({ method: "PUT", path: "/test$file.text", headers: { host, date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-content-sha256": putHash, "x-amz-date": "20130524T000000Z", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, payloadHash: putHash, ...c }).signature === "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
    check("GET bucket lifecycle (a query with no value)", s3lib.sigV4({ method: "GET", path: "/", query: { lifecycle: "" }, headers: common, payloadHash: empty, ...c }).signature === "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
    check("list objects (max-keys, prefix)", s3lib.sigV4({ method: "GET", path: "/", query: { "max-keys": "2", prefix: "J" }, headers: common, payloadHash: empty, ...c }).signature === "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    check("presigned GET, 24 hours", s3lib.presignGet({ origin: `https://${host}`, host, path: "/test.txt", expiresSeconds: 86400, ...c }) === "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    const page = s3lib.parseListObjectsV2(`<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a/b+c%20%28d%29%2B.md</Key><Size>12</Size></Contents><Contents><Key>a/x&amp;y.md</Key><Size>0</Size></Contents><NextContinuationToken>1a&amp;b=</NextContinuationToken></ListBucketResult>`);
    check("a listing's keys are decoded (url-encoded, `+` as a space, XML entities) and its token passed back whole", eq(page, { objects: [{ key: "a/b c (d)+.md", size: 12 }, { key: "a/x&y.md", size: 0 }], hasMore: true, cursor: "1a&b=" }), page);
    useEnv(s3Env());
    const driver = storage.storageDriver();
    const week = await driver.signedUrl(`artifacts/orgs/${A}/x.html`, 30 * 24 * 60 * 60 * 1000);
    check("a link longer than S3 allows is capped at seven days, and says so in its expiry", new URL(week.url).searchParams.get("X-Amz-Expires") === "604800" && Math.abs(week.expiresAt - (Date.now() + 604800_000)) < 5000);
    const before = s3.refused();
    const stolen = await fetch(`${s3.endpoint}/${S3_KEYS.bucket}/artifacts/orgs/${C}/own.html`);
    check("the bucket is private: an unsigned GET is refused", stolen.status === 403 && s3.refused() === before + 1);
    await stolen.arrayBuffer();
  }
} finally {
  await s3.close();
  rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
