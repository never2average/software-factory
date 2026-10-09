#!/usr/bin/env node
/**
 * QUALIFY A FILE STORE before a deployment uses it: run the storage contract against the store the environment
 * selects (STORAGE_DRIVER and its settings; docs/STORAGE.md), over the real network.
 *
 * For a new DigitalOcean Space, a MinIO server or a directory, this answers what the unit tests cannot: do THESE
 * credentials work, is the bucket really private, does this service honour a no-overwrite write, do its listings
 * come back in order and in pages, and does a signed link open (and a tampered one not).
 *
 * It writes only under `dataroom/orgs/storage-probe-<random>/` and removes everything it wrote. It prints setting
 * NAMES and results, never a value.
 *
 *   STORAGE_DRIVER=s3 STORAGE_S3_ENDPOINT=… STORAGE_S3_BUCKET=… STORAGE_S3_ACCESS_KEY_ID=… \
 *   STORAGE_S3_SECRET_ACCESS_KEY=… npm run storage:probe
 *
 * Exit 0 when every check holds, 1 otherwise, 2 when the settings are incomplete.
 */
import { randomBytes } from "node:crypto";

const { storageDriver, storageKind } = await import("../lib/storage/index.ts");

let driver;
try {
  driver = storageDriver();
} catch (error) {
  console.error(`storage-probe: ${error.message}`);
  process.exit(2);
}
if (!driver) {
  console.error("storage-probe: no store is configured (STORAGE_DRIVER is unset and BLOB_READ_WRITE_TOKEN is not set).");
  process.exit(2);
}

let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  }
};
const attempt = async (fn) => {
  try {
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, message: String(error?.message ?? error).slice(0, 200) };
  }
};

const base = `dataroom/orgs/storage-probe-${randomBytes(6).toString("hex")}`;
const written = new Set();
const put = async (key, body, options) => {
  const result = await driver.put(key, body, options);
  written.add(result.ref);
  return result;
};
const listAll = async (prefix, limit) => {
  const out = [];
  let cursor;
  let pages = 0;
  do {
    const page = await driver.list({ prefix, cursor, limit });
    out.push(...page.objects.map((o) => o.key));
    cursor = page.hasMore ? page.cursor : undefined;
    pages++;
  } while (cursor && pages < 50);
  return { keys: out, pages };
};

console.log(`storage-probe: driver ${storageKind()}, writing under ${base}/`);
try {
  const text = `probe ${new Date().toISOString()}\n`;
  await put(`${base}/files/probe/a file (1).md`, text, { addRandomSuffix: false, allowOverwrite: true, contentType: "text/markdown; charset=utf-8" });
  const got = await driver.get(`${base}/files/probe/a file (1).md`, { ttlMs: 60_000 });
  check("write, then read back the same bytes (a key with a space and parentheses)", got !== null && (await got.text()) === text);
  check("a missing key reads as absent", (await driver.get(`${base}/files/probe/none.md`, { ttlMs: 60_000 })) === null);
  const bytes = randomBytes(300_000);
  await put(`${base}/files/probe/blob.bin`, bytes, { addRandomSuffix: false, allowOverwrite: true, contentType: "application/octet-stream" });
  const back = await driver.get(`${base}/files/probe/blob.bin`, { ttlMs: 60_000 });
  check("300 kB of random bytes round-trip unchanged", back !== null && Buffer.from(await back.arrayBuffer()).equals(bytes));
  check("head reports the size", (await driver.head(`${base}/files/probe/blob.bin`))?.size === bytes.length);

  const again = await attempt(() => put(`${base}/files/probe/blob.bin`, "x", { addRandomSuffix: false, allowOverwrite: false }));
  const still = await driver.get(`${base}/files/probe/blob.bin`, { ttlMs: 60_000 });
  const unchanged = still !== null && Buffer.from(await still.arrayBuffer()).equals(bytes);
  check("a write over an existing key without allowOverwrite is refused", again.threw && unchanged, again.threw ? undefined : "THIS STORE IGNORES THE NO-OVERWRITE CONDITION (the app's keys written that way are unique, so it is a lost second guard, not data loss)");

  const names = Array.from({ length: 7 }, (_, i) => `${base}/records/probe/interactions.jsonl.appends/${String(i).padStart(4, "0")}.part`);
  for (const key of names) await put(key, `${key}\n`, { addRandomSuffix: false, allowOverwrite: false, contentType: "application/x-ndjson" });
  await put(`${base}/records/probe/interactions.jsonl`, "{}\n", { addRandomSuffix: false, allowOverwrite: true });
  const parts = await listAll(`${base}/records/probe/interactions.jsonl.appends/`, 3);
  check("a listing comes back complete, in ascending order, across pages of 3", JSON.stringify(parts.keys) === JSON.stringify(names) && parts.pages === 3, parts);
  const plain = await listAll(`${base}/records/probe/interactions.jsonl`, 1000);
  check("a prefix is a plain string prefix (a file and its .appends/ parts)", plain.keys.length === 8 && plain.keys[0] === `${base}/records/probe/interactions.jsonl`, plain.keys.length);
  check("another workspace's prefix lists nothing of this one", (await listAll(`${base}-other/`, 1000)).keys.length === 0);

  const one = await put(`${base}/files/probe/report.html`, "<p>1</p>", { addRandomSuffix: true, contentType: "text/html; charset=utf-8" });
  check("addRandomSuffix stores under a new, suffixed key", one.key !== `${base}/files/probe/report.html` && one.key.startsWith(`${base}/files/probe/report-`) && one.key.endsWith(".html"), one.key);

  const signed = await driver.signedUrl(`${base}/files/probe/a file (1).md`, 120_000);
  const url = new URL(signed.url);
  check("a signed link is one the driver recognises, and names the key", driver.urls.ownsUrl(url) && driver.urls.keyFromUrl(signed.url) === `${base}/files/probe/a file (1).md`);
  const opened = await driver.urls.open(url);
  check("the signed link opens", opened.status === 200 && (await opened.text()) === text, opened.status);
  const tampered = await driver.urls.open(new URL(signed.url.replace(/(sig|X-Amz-Signature|vercel-blob-signature)=.{6}/, "$1=AAAAAA")));
  check("a tampered link is refused", tampered.status === 401 || tampered.status === 403, tampered.status);
  await tampered.arrayBuffer().catch(() => undefined);
  if (driver.kind === "s3") {
    const bare = await fetch(`${url.origin}${url.pathname}`);
    check("THE BUCKET IS PRIVATE: the same object without a signature is refused", bare.status === 401 || bare.status === 403, bare.status);
    await bare.arrayBuffer().catch(() => undefined);
  }
} catch (error) {
  failed.push("the probe ran to completion");
  console.log(`  FAIL the probe threw: ${String(error?.message ?? error).slice(0, 300)}`);
} finally {
  const cleanup = await attempt(() => driver.delete([...written]));
  const left = await attempt(() => listAll(`${base}/`, 1000));
  check("everything the probe wrote is removed", !cleanup.threw && !left.threw && left.value.keys.length === 0, cleanup.threw ? cleanup : left);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
