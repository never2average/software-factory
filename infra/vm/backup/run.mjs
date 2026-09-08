/**
 * One nightly backup: pg_dump -Fc of an app's database into that app's own Vercel Blob store,
 * 7-day retention. Values are pulled at run time into a 0600 temp file and deleted in a finally;
 * nothing is written into the repo and no value is printed.
 *
 *   APP_ID=... VERCEL_PROJECT=... ADMIN_REF=DATABASE_URL_UNPOOLED RETAIN_DAYS=7 node run.mjs
 *
 * Run from the mold directory so @vercel/blob resolves. The admin ref is the DIRECT endpoint, never
 * the pooled one and never DATABASE_URL — that is app_rw, which owns nothing and dumps nothing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { put, list, del } from "@vercel/blob";

const app = process.env.APP_ID, project = process.env.VERCEL_PROJECT;
const ref = process.env.ADMIN_REF || "DATABASE_URL_UNPOOLED";
const retain = Number(process.env.RETAIN_DAYS || 7);
const d = mkdtempSync(join(tmpdir(), "factory-backup-"));
try {
  const f = join(d, ".env");
  execFileSync("vercel", ["env", "pull", "--yes", "--environment=production", "--project", project, f], { stdio: "ignore" });
  const text = readFileSync(f, "utf8");
  const get = (k) => (text.match(new RegExp("^" + k + '="?([^"\n]+)', "m")) || [])[1];
  const url = get(ref) || get("DATABASE_URL");
  const token = get("BLOB_READ_WRITE_TOKEN");
  if (!url) throw new Error(`${project} has no ${ref}`);
  if (!token) throw new Error(`${project} has no BLOB_READ_WRITE_TOKEN`);
  const dump = join(d, "db.dump");
  const r = spawnSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", dump, url], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) throw new Error("pg_dump failed: " + String(r.stderr).slice(-300));
  const key = `backups/${app}/${new Date().toISOString().slice(0, 10)}.dump`;
  // access:"private" is the whole security posture of this file. A dump is the entire multi-tenant
  // database — every org's rows and connector_secrets — so "public" would serve it from
  // https://$storeId.public.blob.vercel-storage.com/$pathname with no auth, and addRandomSuffix:false
  // makes that URL guessable from the app id and the date. The store is created --access private;
  // this matches it, and the assertion below refuses to leave a public object behind if it ever drifts.
  const blob = await put(key, readFileSync(dump), { access: "private", addRandomSuffix: false, allowOverwrite: true, token });
  if (/\.public\.blob\.vercel-storage\.com/.test(blob.url || "")) {
    await del([blob.url], { token });
    throw new Error("refusing to keep a publicly addressable database dump; the upload was deleted");
  }
  console.log(`${key} ${blob.size} bytes (private)`);
  const cutoff = Date.now() - retain * 86400000;
  const { blobs } = await list({ prefix: `backups/${app}/`, token });
  const old = blobs.filter((b) => new Date(b.uploadedAt).getTime() < cutoff).map((b) => b.url);
  if (old.length) { await del(old, { token }); console.log(`pruned ${old.length} backup(s) older than ${retain}d`); }
} finally {
  rmSync(d, { recursive: true, force: true });
}
