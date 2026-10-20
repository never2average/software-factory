/**
 * Hermetic test of the R2 archive (src/storage.ts, src/archive.ts): real server modules on a temp PGlite (Postgres
 * transcript store) + a mock S3 API. Archive a finished session and a research job, lose the live transcript, read it
 * through from the archive, restore it, and check the bucket layout.
 *
 *   npx tsx orchestrator/test/archive.ts
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "octillion-artest-"));
const PORT = Number(process.env.ARTEST_S3_PORT ?? 3407);
Object.assign(process.env, {
  PGLITE_DIR: path.join(tmp, "pglite"), OCTILLION_VAULT_KEY: randomBytes(32).toString("base64"),
  R2_BUCKET: "test-bucket", R2_ENDPOINT: `http://127.0.0.1:${PORT}`, R2_ACCESS_KEY_ID: "AKIATEST", R2_SECRET_ACCESS_KEY: "secret-test",
  OCTILLION_ARCHIVE_BATCH: "50",
});
delete process.env.DATABASE_URL; delete process.env.CLICKHOUSE_URL;

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` - ${detail}` : ""}`); };

// ---------------------------------------------------------------- mock S3 (path-style)
const objects = new Map<string, { body: Buffer; type: string; at: Date }>();
const s3 = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const u = new URL(String(req.url), "http://x");
    const [, bucket, ...rest] = u.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    if (bucket !== "test-bucket" || !String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256")) { res.writeHead(403); return res.end(); }
    if (req.method === "PUT" && key) { objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers["content-type"] ?? ""), at: new Date() }); res.writeHead(200, { etag: '"x"' }); return res.end(); }
    if (req.method === "GET" && key) {
      const o = objects.get(key);
      if (!o) { res.writeHead(404, { "content-type": "application/xml" }); return res.end("<Error><Code>NoSuchKey</Code></Error>"); }
      res.writeHead(200, { "content-type": o.type, "content-length": o.body.length }); return res.end(o.body);
    }
    if (req.method === "GET" && u.searchParams.get("list-type") === "2") {
      const prefix = u.searchParams.get("prefix") ?? "";
      const items = [...objects].filter(([k]) => k.startsWith(prefix));
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>test-bucket</Name><Prefix>${prefix}</Prefix><KeyCount>${items.length}</KeyCount><IsTruncated>false</IsTruncated>` +
        items.map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.body.length}</Size><LastModified>${o.at.toISOString()}</LastModified></Contents>`).join("") + "</ListBucketResult>");
    }
    res.writeHead(400); res.end();
  });
});
await new Promise<void>((r) => s3.listen(PORT, "127.0.0.1", () => r()));

const { getDb } = await import("../../src/db.js");
const { createOrg } = await import("../../src/auth.js");
const q = await import("../../src/queries.js");
const { transcripts, baseTranscripts } = await import("../../src/transcripts.js");
const archive = await import("../../src/archive.js");
const storage = await import("../../src/storage.js");
const db = await getDb();

try {
  const { org: O } = await createOrg("Archive Test", "artest");
  const { org: O2 } = await createOrg("Other Org", "arother");
  await q.saveProduct(O, { name: "left-pad", packages: ["left-pad"] });
  await q.saveScenarios(O, "left-pad", [{ title: "pad", prompt: "Add zero padding to the invoice numbers in this small Node project, with a test." }]);
  const sim = (await q.runSimulation(O, { product: "left-pad", agents: ["codex/default"], repeats: 2 })).simulation.id as string;
  const sessions = await db.query<any>("SELECT id, org_id, product_id, simulation_id, model FROM agent_sessions WHERE simulation_id = $1 ORDER BY id", [sim]);
  const [a, b] = sessions;
  const events = Array.from({ length: 1203 }, (_, i) => ({ seq: i + 1, ts: new Date().toISOString(), type: i % 2 ? "assistant" : "tool_use", text: `event ${i + 1}`, raw: { n: i + 1 } }));
  for (let i = 0; i < events.length; i += 500) await baseTranscripts().append(a, events.slice(i, i + 500));
  await db.query("UPDATE agent_sessions SET status = 'completed', verdict = 'adopted', ended_at = now() - interval '10 minutes' WHERE id = $1", [a.id]);
  await db.query("UPDATE agent_sessions SET status = 'running', started_at = now() WHERE id = $1", [b.id]); // not finished: never archived
  await db.query(`INSERT INTO product_research (id, org_id, product_id, input, status, result, finished_at) VALUES ('rsh_artest1', $1, (SELECT id FROM products WHERE org_id = $1), '{"prompt":"x"}', 'completed', '{"product":{"name":"left-pad"}}', now())`, [O.orgId]);

  const sweep = await archive.archiveSweep();
  const [row] = await db.query<any>("SELECT archive_key, archive_events FROM agent_sessions WHERE id = $1", [a.id]);
  const [running] = await db.query<any>("SELECT archive_key FROM agent_sessions WHERE id = $1", [b.id]);
  check("sweep archives finished sessions and research, not running ones", sweep.sessions === 1 && sweep.research === 1 && !running.archive_key, JSON.stringify(sweep));
  check("layout: transcripts/org-<id>/<yyyy-mm>/<session>.jsonl.gz", new RegExp(`^transcripts/org-${O.orgId}/\\d{4}-\\d{2}/${a.id}\\.jsonl\\.gz$`).test(row.archive_key) && row.archive_events === 1203, row.archive_key);
  check("layout: research/org-<id>/<research_id>.json", objects.has(`research/org-${O.orgId}/rsh_artest1.json`) && JSON.parse(objects.get(`research/org-${O.orgId}/rsh_artest1.json`)!.body.toString()).result.product.name === "left-pad", [...objects.keys()].join(","));
  const parsed = archive.parseArchive(objects.get(row.archive_key)!.body);
  check("archive: header with session metadata, then every event in order", (parsed.header as any)?.id === a.id && (parsed.header as any)?.verdict === "adopted" &&
    parsed.events.length === 1203 && parsed.events[0]!.seq === 1 && parsed.events[1202]!.seq === 1203, JSON.stringify(parsed.header).slice(0, 200));
  check("a second sweep re-archives nothing", (await archive.archiveSweep()).sessions === 0, "");

  // the live store loses the trace (ClickHouse lapsed): reads come from the archive
  await baseTranscripts().remove(a.org_id, a.id);
  const live = await baseTranscripts().read(a.org_id, a.id, 0, 10);
  const through = await transcripts().read(a.org_id, a.id, 1200, 10);
  check("read-through: live store empty, archive serves the session (with paging)", live.total === 0 && through.total === 1203 && through.events.length === 3 && through.events[0]!.seq === 1201, `${live.total} / ${through.total}`);
  const otherOrg = await transcripts().read(O2.orgId, a.id, 0, 10);
  check("read-through is org-scoped (another org gets nothing)", otherOrg.total === 0, String(otherOrg.total));

  // restore into the live store
  const r = await archive.restoreArchives({ log: () => {} });
  const back = await baseTranscripts().read(a.org_id, a.id, 0, 2000);
  check("restore loads the archive back into the live store", r.restored === 1 && r.events === 1203 && back.total === 1203, JSON.stringify(r));
  const again = await archive.restoreArchives({ log: () => {} });
  check("restore is safe to re-run (skips sessions already present)", again.restored === 0 && again.skipped === 1, JSON.stringify(again));

  // signed links and key safety
  const url = await storage.signedUrl(row.archive_key, 3600, "trace.jsonl.gz");
  check("signed link: path-style, expiring, attachment name", url.startsWith(`http://127.0.0.1:${PORT}/test-bucket/transcripts/`) && /X-Amz-Expires=3600/.test(url) && /response-content-disposition/i.test(url), url.slice(0, 120));
  let unsafe = false; try { storage.keys.report(1, "../etc", new Date(), "pdf"); } catch { unsafe = true; }
  check("keys reject path tricks", unsafe, "");
  check("report key layout", /^reports\/org-7\/sim_abc\/\d{4}-\d{2}-\d{2}T\d{6}Z\.pdf$/.test(storage.keys.report(7, "sim_abc", new Date(), "pdf")), storage.keys.report(7, "sim_abc", new Date(), "pdf"));
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
}
s3.close();
await db.close();
rmSync(tmp, { recursive: true, force: true });
const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "ARCHIVE TEST PASS" : "ARCHIVE TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
