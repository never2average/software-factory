// Blob I/O for the pack's data-room migrations. Driven by a migration script; never run by hand.
//
//   node blobio.mjs scan   env: BLOB_READ_WRITE_TOKEN, MOLD_DIR, MATCH (regex on the object pathname), PREFIX (default "dataroom/")
//        -> stdout JSON {"listed": n, "objects": [{pathname, size, uploadedAt, contentType, b64}]} for the matching objects
//   node blobio.mjs check  env: BLOB_READ_WRITE_TOKEN, MOLD_DIR -> {"ok": true} when the token can list the store
//   node blobio.mjs put    env: BLOB_READ_WRITE_TOKEN, MOLD_DIR; stdin JSON [{pathname, b64, contentType, size, uploadedAt}]
//        -> stdout JSON {"written": [...], "skipped": [{pathname, why}]}
//
// The store is private: reads are authenticated GETs with the token, as .claude/scripts/lib/surface.mjs does.
// `put` overwrites the SAME pathname (no random suffix), so an append part stays a part and keeps its sort key.
// Before each put the object is looked up again: if it is gone or changed since the scan (a write() retired it,
// or it was rewritten), it is skipped, so a migration never resurrects a stale part. After each put the object
// is read back and compared byte for byte.
// The token only ever comes from the environment; nothing here prints it.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const MOLD = process.env.MOLD_DIR;
if (!MOLD) { console.error("blobio: MOLD_DIR is not set"); process.exit(2); }
const require = createRequire(MOLD + "/package.json");
const { list, put, head } = require("@vercel/blob");
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) { console.error("blobio: BLOB_READ_WRITE_TOKEN is not set"); process.exit(2); }

async function download(url) {
  const res = await fetch(url, { headers: { authorization: "Bearer " + token } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
}
const sha = (b) => createHash("sha256").update(b).digest("hex");

async function scan() {
  const prefix = process.env.PREFIX ?? "dataroom/";
  const match = new RegExp(process.env.MATCH ?? "^$");
  const objects = []; let listed = 0, cursor;
  do {
    const r = await list({ token, prefix, cursor, limit: 1000 });
    for (const b of r.blobs) {
      listed++;
      if (!match.test(b.pathname)) continue;
      const { body, contentType } = await download(b.url);
      if (body.length !== b.size) throw new Error(`download ${b.pathname}: got ${body.length} bytes, expected ${b.size}`);
      objects.push({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt, contentType, b64: body.toString("base64") });
    }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return { listed, objects };
}

async function putAll(items) {
  const written = [], skipped = [];
  for (const it of items) {
    let now;
    try { now = await head(it.pathname, { token }); } catch { now = null; }
    if (!now) { skipped.push({ pathname: it.pathname, why: "gone since the scan (the file was rewritten); re-run the migration" }); continue; }
    if (now.size !== it.size || new Date(now.uploadedAt).getTime() !== new Date(it.uploadedAt).getTime()) {
      skipped.push({ pathname: it.pathname, why: "changed since the scan; re-run the migration" }); continue;
    }
    const body = Buffer.from(it.b64, "base64");
    await put(it.pathname, body, { token, access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: it.contentType ?? undefined });
    const back = await head(it.pathname, { token });
    const { body: got } = await download(back.url);
    if (sha(got) !== sha(body)) throw new Error(`read-back of ${it.pathname} differs from what was written`);
    written.push(it.pathname);
  }
  return { written, skipped };
}

const cmd = process.argv[2];
let out;
if (cmd === "check") { await list({ token, prefix: "dataroom/", limit: 1 }); out = { ok: true }; }
else if (cmd === "scan") out = await scan();
else if (cmd === "put") out = await putAll(JSON.parse(readFileSync(0, "utf8")));
else { console.error("usage: blobio.mjs check|scan|put"); process.exit(2); }
process.stdout.write(JSON.stringify(out));
