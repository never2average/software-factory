// Record files and document previews (mold_v0-220; src/record-files.ts, src/record-files-config.ts,
// src/document-fetch.ts, src/html-sanitise.ts), offline: an embedded database, the stand-in Clerk, a local object store
// and a stand-in document host on 127.0.0.1 (APP_DOCUMENT_FETCH_STANDIN). No real host is fetched.
//   npm run test:record-files
//
//  1. The declaration: a file field holds a stored file {object, name, size, content_type, sha256} or a store path;
//     preview: "document" only on a text field (not encrypted); a pack that previews documents names their hosts.
//  2. Round trip: a file kept for a record (sealed at rest under the workspace's prefix, bound to its record), listed as a
//     card, previewed and downloaded at a signed link with its bytes intact.
//  3. Never inlined: the bytes appear in no list, record answer, export (CSV: the name only), MCP answer, data trail
//     entry or log line.
//  4. Permission: the area's read roles (a viewer it excludes gets 404), another workspace (404), another person's link,
//     a forged or expired link (403); a reference copied into another record does not open (404).
//  5. HTML: scripts, handlers, iframes, forms, styles with url(), javascript: links gone; links to a new tab; remote
//     images blocked (and counted) until images=1; the policy runs no script and loads no remote image.
//  6. The data trail: a preview is a `read` of a file, a download an `export`, with the record's key and the file's
//     place, never its name or bytes.
//  7. URL documents: the allowlist (a listed host and its subdomains only; https, port 443, no credentials, no address;
//     a redirect off the list; a private address), the size limit, the type check; a fetched document cached (fetched
//     once), previewed in a shared area for every workspace and for staff, a failure said on the card.
//  8. Uploads from the console (mold_v0-238): POST /api/data/<area>/<key>/files/<field> keeps one file for the record
//     (sealed, bound to its key) and answers its reference, which the create writes; only bytes as
//     application/octet-stream, a file field of a workspace area of the shell's tables, a role that may write it, at
//     most the upload limit; DELETE removes one kept but never written (never one the record holds, never another
//     key's); each a create or delete of a file in the data trail; off with document_preview.
//  9. A url field (mold_v0-238): an http or https address checked on every write (the data API, the MCP tools), its
//     document a card when it previews one.
// 10. An area's own lists (mold_v0-237): GET /api/tab-actions/_areas/<area> gives the create action of an area its
//     people may add to (who may, its fields, the upload limit), none for a shared area; the cards of its own lists.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
process.env.APP_SCHEDULER = "off";
process.env.APP_EMAIL_INTAKE = "off";

let printed = "";
for (const s of [process.stdout, process.stderr]) {
  const w = s.write.bind(s);
  (s as any).write = (chunk: any, ...rest: any[]) => { printed += String(chunk); return w(chunk, ...rest); };
}
let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };

const MARK = `FILEBYTES-${randomBytes(6).toString("hex")}`;
const PDF = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${MARK}\n%%EOF\n`);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const HTML = `<html><head><style>body{background:url(https://evil.example/bg.png)}</style><script>steal()</script></head><body>
<p onclick="steal()">Dear team, ${MARK}</p><img src="https://tracker.example/pixel.gif" alt="logo"><img src="cid:inline-1"><iframe src="https://evil.example"></iframe>
<form action="https://evil.example"><input name="x"></form><a href="javascript:steal()">bad</a><a href="java&#115;cript:steal()">bad2</a>
<a href="https://regulator.example/circular" target="_self">the circular</a><div style="color:red;background-image:url(https://evil.example/x)">styled</div><svg><script>x()</script></svg></body></html>`;

// The stand-in document host: /<host><path> as the real host would answer.
const fetched: string[] = [];
const host = createServer((req, res) => {
  fetched.push(String(req.url));
  const u = String(req.url);
  if (u === "/regs.example/circular.pdf" || u === "/www.regs.example/c2.pdf") return void res.writeHead(200, { "content-type": "application/pdf" }).end(PDF);
  if (u === "/regs.example/octet.pdf") return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(PDF);
  if (u === "/regs.example/page") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
  if (u === "/regs.example/big.pdf") return void res.writeHead(200, { "content-type": "application/pdf" }).end(Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024)]));
  if (u === "/regs.example/archive.zip") return void res.writeHead(200, { "content-type": "application/zip" }).end(Buffer.from("PK\u0003\u0004zip"));
  if (u === "/regs.example/away") return void res.writeHead(302, { location: "https://evil.example/x.pdf" }).end();
  if (u === "/regs.example/hop") return void res.writeHead(301, { location: "/circular.pdf" }).end();
  if (u === "/regs.example/gone") return void res.writeHead(404).end("no");
  res.writeHead(404).end();
});
await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
process.env.APP_DOCUMENT_FETCH_STANDIN = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const audit = await import("../src/audit-trail.js");
  const { definePack, RecordAreaSchema } = await import("../src/pack-api.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const rec = await import("../src/record-areas.js");
  const files = await import("../src/record-files.js");
  const { sanitiseHtml, htmlPolicy } = await import("../src/html-sanitise.js");
  const fetcher = await import("../src/document-fetch.js");
  const { exportArea } = await import("../src/record-export.js");

  // ---------- 1. the declaration ----------
  const CASES = {
    name: "cases", label: "Cases", role: "source", scope: "workspace", list_columns: ["subject", "files"],
    permissions: { read: ["member", "owner"] },
    fields: [{ name: "subject", label: "Subject" }, { name: "files", label: "Files", type: "file", multiple: true }, { name: "cover", label: "Cover", type: "file" },
      { name: "link", label: "Their page", type: "text", preview: "document" }, { name: "site", label: "Site", type: "url", preview: "document" },
      { name: "home", label: "Home page", type: "url" }],
  };
  const INSTRUMENTS = {
    name: "instruments", label: "Instruments", role: "source", scope: "platform", list_columns: ["url"],
    fields: [{ name: "url", label: "Official text", type: "text", preview: "document" }],
  };
  {
    assert.ok(RecordAreaSchema.safeParse(CASES).success, JSON.stringify(RecordAreaSchema.safeParse(CASES).error?.issues));
    const bad = (f: object, want: RegExp) => { const r = RecordAreaSchema.safeParse({ ...CASES, fields: [...CASES.fields, f] }); assert.ok(!r.success); assert.match(JSON.stringify(r.error.issues), want); };
    bad({ name: "n", label: "N", type: "number", preview: "document" }, /for a url field, or a text field/);
    bad({ name: "e", label: "E", type: "text", preview: "document", encrypted: true }, /not encrypted/);
    bad({ name: "e", label: "E", type: "text", preview: "page" }, /preview/);
    assert.throws(() => definePack({ id: "nohosts", recordAreas: [INSTRUMENTS] as never }), /declare documents\.hosts/);
    assert.throws(() => definePack({ id: "badhosts", recordAreas: [INSTRUMENTS] as never, documents: { hosts: ["https://x.example/"] } as never }), /documents\.hosts/);
    ok("declaration: file fields take stored files; preview: document on a plain text field only; a pack that previews documents lists their hosts");
  }

  const pack = definePack({ id: "filefix", recordAreas: [CASES, INSTRUMENTS] as never, documents: { hosts: ["regs.example", "*.other.example"], max_bytes: 1024 * 1024 } });
  setPacksForTest([{ manifest: { id: "filefix", name: "File fixture", version: "1", entry: null, migrations: null, words: {}, dir: "packs/filefix" }, definition: pack }]);
  audit.setAuditForTest({ data: true, platform: false });
  const A = (await createOrg(`Files A ${STAMP}`)).org, B = (await createOrg(`Files B ${STAMP}`)).org;
  const http = await startHttp();
  const seen: string[] = [];
  const req = async (p: string, tok: string) => {
    const r = await http.req("GET", p, { authorization: `Bearer ${tok}` });
    const bytes = Buffer.from(await r.arrayBuffer());
    seen.push(bytes.toString("latin1"));
    let json: any = null;
    try { json = JSON.parse(bytes.toString("utf8")); } catch { /* bytes */ }
    return { status: r.status, json, bytes, headers: r.headers };
  };
  try {
    const ownerA = await http.signIn(A, "owner"), memberA = await http.signIn(A, "member"), viewerA = await http.signIn(A, "viewer"), ownerB = await http.signIn(B, "owner");
    const area = rec.findArea("cases")!;

    // ---------- 2. round trip ----------
    const pdfRef = await files.storeRecordFile(A.orgId, area, "case-1", { name: "../../evil/notice.pdf", content_type: "application/octet-stream", data: PDF });
    const pngRef = await files.storeRecordFile(A.orgId, area, "case-1", { name: "chart.png", content_type: "image/png", data: PNG });
    const htmlRef = await files.storeRecordFile(A.orgId, area, "case-1", { name: "message.html", content_type: "text/html", data: Buffer.from(HTML) });
    const txtRef = await files.storeRecordFile(A.orgId, area, "case-1", { name: "notes.txt", content_type: "text/plain", data: Buffer.from(`plain notes ${MARK}`) });
    const xlsRef = await files.storeRecordFile(A.orgId, area, "case-1", { name: "sheet.xlsx", content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: Buffer.from(`PK\u0003\u0004 ${MARK}`) });
    assert.equal(pdfRef.name, "notice.pdf", "a name without its directories"); assert.equal(pdfRef.content_type, "application/pdf", "the type its bytes say");
    assert.match(pdfRef.object, /^rf_[0-9a-f]{32}$/); assert.equal(pdfRef.size, PDF.length);
    const recs = rec.workspaceRecords("filefix", A.orgId);
    await withTenant(A.orgId, () => recs.create("cases", "case-1", { title: "Case one", data: { subject: "Notice", files: [pdfRef, pngRef, htmlRef, txtRef, xlsRef] } }));
    await withTenant(A.orgId, () => recs.create("cases", "case-2", { title: "Case two", data: { subject: "Copied", cover: pdfRef } }));
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const objects = walk(path.join(TMP, "objects")).filter((f) => f.includes(`${path.sep}.records${path.sep}`));
    assert.equal(objects.length, 5);
    assert.ok(objects.every((f) => f.includes(`${path.sep}org-${A.orgId}${path.sep}.records${path.sep}cases${path.sep}`)), "under A's own prefix");
    for (const f of objects) assert.ok(!readFileSync(f).includes(MARK) && !readFileSync(f).includes("%PDF"), `${f} is sealed at rest`);
    const cards = await req("/api/records/cases/case-1/files", memberA);
    assert.equal(cards.status, 200, JSON.stringify(cards.json));
    assert.deepEqual(cards.json.files.map((c: any) => [c.name, c.preview, c.size]),
      [["notice.pdf", "pdf", PDF.length], ["chart.png", "image", PNG.length], ["message.html", "html", Buffer.byteLength(HTML)], ["notes.txt", "text", Buffer.byteLength(`plain notes ${MARK}`)], ["sheet.xlsx", null, Buffer.byteLength(`PK\u0003\u0004 ${MARK}`)]]);
    const card = (name: string) => cards.json.files.find((c: any) => c.name === name);
    const pdf = await req(card("notice.pdf").preview_url, memberA);
    assert.equal(pdf.status, 200); assert.ok(pdf.bytes.equals(PDF), "the PDF's bytes intact");
    assert.equal(pdf.headers.get("content-type"), "application/pdf"); assert.match(String(pdf.headers.get("content-disposition")), /^inline; filename="notice.pdf"/);
    assert.match(String(pdf.headers.get("content-security-policy")), /frame-ancestors 'self'/); assert.equal(pdf.headers.get("x-content-type-options"), "nosniff");
    const png = await req(card("chart.png").preview_url, memberA);
    assert.ok(png.bytes.equals(PNG)); assert.equal(png.headers.get("content-type"), "image/png");
    const txt = await req(card("notes.txt").preview_url, memberA);
    assert.equal(txt.bytes.toString(), `plain notes ${MARK}`); assert.match(String(txt.headers.get("content-type")), /^text\/plain/); assert.match(String(txt.headers.get("content-security-policy")), /sandbox/);
    const dl = await req(card("sheet.xlsx").download_url, memberA);
    assert.equal(dl.status, 200); assert.equal(dl.headers.get("content-type"), "application/octet-stream");
    assert.match(String(dl.headers.get("content-disposition")), /^attachment; filename="sheet.xlsx"/); assert.match(String(dl.headers.get("content-security-policy")), /sandbox/);
    assert.equal(card("sheet.xlsx").preview_url, null, "no preview for a spreadsheet");
    assert.equal((await req(card("sheet.xlsx").download_url.replace("mode=download", "mode=inline"), memberA)).status, 415, "and none when asked");
    ok("round trip: kept sealed under the workspace's prefix, bound to the record; cards with name, type and size; PDF, image and text previews and downloads byte for byte; a spreadsheet download only");

    // ---------- 3. never inlined ----------
    {
      const list = await req("/api/records/cases", memberA);
      const one = await req("/api/records/cases/case-1", memberA);
      assert.deepEqual(list.json.records.find((r: any) => r.key === "case-1").data.files.map((f: any) => f.name), ["notice.pdf", "chart.png", "message.html", "notes.txt", "sheet.xlsx"]);
      const csv = (await withTenant(A.orgId, () => exportArea({ orgId: A.orgId, role: "member", userId: null }, "cases"))).csv as string;
      assert.match(csv, /notice\.pdf; chart\.png; message\.html; notes\.txt; sheet\.xlsx/, "the export lists the names");
      assert.ok(!csv.includes("rf_"), "never the objects");
      const mcp = await connect({ ...A, role: "member" } as never);
      const got = await mcp.call("get_record", { area: "cases", key: "case-1" });
      const listed = await mcp.call("list_records", { area: "cases" });
      await mcp.close();
      for (const t of [list.bytes.toString(), one.bytes.toString(), csv, JSON.stringify(got), JSON.stringify(listed)]) assert.ok(!t.includes(MARK) && !t.includes("%PDF"), "no bytes in a list, record, export or MCP answer");
      await audit.flushAudit();
      const trail = JSON.stringify(await db.query("SELECT * FROM audit_data_events"));
      assert.ok(!trail.includes(MARK) && !trail.includes("notice.pdf"), "no bytes or file name in the data trail");
      assert.ok(!printed.includes(MARK), "nothing logged holds them");
      const [stored] = await db.query<{ data: string }>("SELECT data::text AS data FROM workspace_records WHERE org_id = $1 AND key = 'case-1'", [A.orgId]);
      assert.ok(!stored!.data.includes(MARK), "the database holds references only");
      ok("never inlined: lists, the record, Export CSV (names only), MCP, the data trail, the database and the logs hold no file's bytes");
    }

    // ---------- 4. permission ----------
    {
      assert.equal((await req("/api/records/cases/case-1/files", viewerA)).status, 403, "a role the area does not let read");
      assert.equal((await req(card("notice.pdf").preview_url, viewerA)).status, 403, "a member's link is not a viewer's");
      assert.equal((await req("/api/records/cases/case-1/files", ownerB)).status, 404, "another workspace never finds the record");
      assert.equal((await req(card("notice.pdf").preview_url, ownerB)).status, 403, "nor opens A's link");
      assert.equal((await req(card("notice.pdf").preview_url, ownerA)).status, 403, "a link is its person's");
      assert.equal((await req(card("notice.pdf").preview_url.replace(/t=[^&]+/, "t=AAAA"), memberA)).status, 403, "a forged link");
      assert.equal((await req(card("notice.pdf").preview_url.replace(/exp=\d+/, "exp=1000"), memberA)).status, 403, "an expired link");
      assert.equal((await req(card("notice.pdf").preview_url.replace("/case-1/", "/case-2/").replace("/files/1", "/cover/1"), memberA)).status, 403, "a link names its record and field");
      // case-2 holds case-1's reference: it does not open there (bound to case-1).
      const c2 = await req("/api/records/cases/case-2/files", memberA);
      assert.equal(c2.json.files.length, 1);
      assert.equal((await req(c2.json.files[0].preview_url, memberA)).status, 404, "a copied reference does not open in another record");
      // B writes A's reference into its own record: nothing opens.
      await withTenant(B.orgId, () => rec.workspaceRecords("filefix", B.orgId).create("cases", "case-1", { title: "B's", data: { files: [pdfRef] } }));
      const bc = await req("/api/records/cases/case-1/files", ownerB);
      assert.equal((await req(bc.json.files[0].preview_url, ownerB)).status, 404, "another workspace's reference opens nothing");
      // A locked vault: nothing opens.
      const key = process.env.APP_VAULT_KEY; delete process.env.APP_VAULT_KEY;
      const fresh = await req("/api/records/cases/case-1/files", memberA);
      process.env.APP_VAULT_KEY = key;
      assert.ok(fresh.status === 503 || fresh.status === 500, `a locked vault serves no link (${fresh.status})`);
      ok("permission: the area's read roles, the workspace, the person and the file a link names; forged and expired links; a reference copied to another record or workspace opens nothing; a locked vault serves none");
    }

    // ---------- 5. HTML ----------
    {
      const blocked = sanitiseHtml(HTML);
      for (const bad of ["<script", "steal()", "onclick", "<iframe", "<form", "<input", "url(", "javascript:", "<style", "<svg", "cid:", "tracker.example"]) assert.ok(!blocked.html.includes(bad), `${bad} is gone`);
      assert.equal(blocked.blocked, 1, "one remote image blocked");
      assert.match(blocked.html, /<a href="https:\/\/regulator\.example\/circular" target="_blank" rel="noopener noreferrer nofollow">the circular<\/a>/);
      assert.match(blocked.html, /<div>styled<\/div>/, "a style with url() is dropped whole");
      assert.ok(sanitiseHtml(HTML, { remoteImages: "allow" }).html.includes('src="https://tracker.example/pixel.gif"'));
      assert.equal(sanitiseHtml('<img src="data:image/png;base64,iVBOR">').html, '<img src="data:image/png;base64,iVBOR">', "inline images stay");
      assert.equal(sanitiseHtml("<scr<script>ipt>alert(1)</script>").html.includes("<script"), false);
      assert.equal(sanitiseHtml('<a href=" &#x6A;avascript:alert(1)">x</a>').html, '<a target="_blank" rel="noopener noreferrer nofollow">x</a>');
      assert.equal(sanitiseHtml("<p title='x\" onmouseover=alert(1)'>t</p>").html, '<p title="x&quot; onmouseover=alert(1)">t</p>', "a value never breaks out");
      assert.equal(sanitiseHtml("a < b > c").html, "a &lt; b &gt; c");
      assert.doesNotMatch(htmlPolicy(false), /script-src|img-src[^;]*https/); assert.match(htmlPolicy(true), /img-src data: https: http:/); assert.match(htmlPolicy(false), /sandbox allow-popups/);
      const shown = await req(card("message.html").preview_url, memberA);
      assert.match(String(shown.headers.get("content-type")), /^text\/html/);
      assert.ok(!/<script|onclick|javascript:|tracker\.example/.test(shown.bytes.toString()) && shown.bytes.toString().includes(MARK), "served sanitised, the text kept");
      assert.equal(shown.headers.get("content-security-policy"), htmlPolicy(false));
      const images = await req(`${card("message.html").preview_url}&images=1`, memberA);
      assert.ok(images.bytes.toString().includes("https://tracker.example/pixel.gif")); assert.equal(images.headers.get("content-security-policy"), htmlPolicy(true));
      ok("HTML: scripts, handlers, frames, forms, styles with url(), javascript: links, cid: and remote images gone (remote ones until images=1); links to a new tab; no attribute breaks out; served with a no-script, no-remote-image, sandboxed policy");
    }

    // ---------- 6. the data trail ----------
    {
      await audit.flushAudit();
      const rows = await db.query<{ action: string; target: string; area: string; record_key: string }>(
        "SELECT action, target, area, record_key FROM audit_data_events WHERE org_id = $1 AND target = 'file' ORDER BY seq", [A.orgId]);
      assert.ok(rows.some((r) => r.action === "read" && r.record_key === "case-1:files/1" && r.area === "cases"), JSON.stringify(rows));
      assert.ok(rows.some((r) => r.action === "export" && r.record_key === "case-1:files/5"), "a download is an export");
      assert.ok(!rows.some((r) => /notice|sheet/.test(r.record_key)), "the place, never the name");
      ok(`data trail: ${rows.length} file entries (a preview a read, a download an export), each with the record's key and the file's place`);
    }

    // ---------- 7. URL documents ----------
    {
      const H = ["regs.example", "*.other.example"];
      const refuse = (u: string, kind: string) => assert.throws(() => fetcher.checkDocumentUrl(u, H), (e: any) => e.kind === kind, u);
      refuse("http://regs.example/a.pdf", "not_allowed"); refuse("https://evil.example/a.pdf", "not_allowed"); refuse("https://regs.example.evil.example/a", "not_allowed");
      refuse("https://user:pw@regs.example/a", "not_allowed"); refuse("https://regs.example:8443/a", "not_allowed"); refuse("https://127.0.0.1/a", "not_allowed");
      refuse("https://[::1]/a", "not_allowed"); refuse("file:///etc/passwd", "not_allowed"); refuse("not a url", "bad_url");
      assert.ok(fetcher.checkDocumentUrl("https://a.b.other.example/x", H) && fetcher.checkDocumentUrl("https://other.example/x", H) && fetcher.checkDocumentUrl("https://www.regs.example/x", H));
      await assert.rejects(fetcher.fetchDocument("https://regs.example/away", H), (e: any) => e.kind === "not_allowed", "a redirect off the list");
      assert.equal((await fetcher.fetchDocument("https://regs.example/hop", H)).content_type, "application/pdf", "a redirect on the list");
      await assert.rejects(fetcher.fetchDocument("https://regs.example/big.pdf", H, 1024 * 1024), (e: any) => e.kind === "too_large");
      await assert.rejects(fetcher.fetchDocument("https://regs.example/archive.zip", H), (e: any) => e.kind === "unsupported_type");
      await assert.rejects(fetcher.fetchDocument("https://regs.example/gone", H), (e: any) => e.kind === "http_error");
      assert.equal((await fetcher.fetchDocument("https://regs.example/octet.pdf", H)).content_type, "application/pdf", "a PDF by its bytes");
      assert.ok(!fetched.some((u) => u.includes("evil")), "nothing off the list was ever requested");
      // Without the stand-in: a private address is refused before any connection.
      const stand = process.env.APP_DOCUMENT_FETCH_STANDIN; delete process.env.APP_DOCUMENT_FETCH_STANDIN;
      await assert.rejects(fetcher.fetchDocument("https://localhost/a.pdf", ["localhost"]), (e: any) => e.kind === "private_address", "localhost resolves to a private address");
      process.env.APP_DOCUMENT_FETCH_STANDIN = stand;

      const { putPlatform } = rec;
      await putPlatform(null, "instruments", "circ-1", { title: "Circular 1", data: { url: "https://regs.example/circular.pdf" } });
      await putPlatform(null, "instruments", "page-1", { title: "A page", data: { url: "https://regs.example/page" } });
      await putPlatform(null, "instruments", "off-1", { title: "Off the list", data: { url: "https://evil.example/doc.pdf" } });
      await putPlatform(null, "instruments", "gone-1", { title: "Gone", data: { url: "https://regs.example/gone" } });
      const before = fetched.length;
      const ca = await req("/api/records/instruments/circ-1/files", viewerA);
      assert.equal(ca.status, 200, JSON.stringify(ca.json));
      assert.deepEqual(ca.json.files.map((c: any) => [c.name, c.preview, c.source, c.url]), [["circular.pdf", "pdf", "document", "https://regs.example/circular.pdf"]]);
      const doc = await req(ca.json.files[0].preview_url, viewerA);
      assert.ok(doc.bytes.equals(PDF)); assert.equal(doc.headers.get("content-type"), "application/pdf");
      const cb = await req("/api/records/instruments/circ-1/files", ownerB);
      assert.ok((await req(cb.json.files[0].preview_url, ownerB)).bytes.equals(PDF), "a shared area's document for every workspace");
      const staff = await http.adminToken("viewer");
      const cs = await req("/api/admin/records/instruments/circ-1/files", staff);
      assert.equal(cs.status, 200, JSON.stringify(cs.json));
      assert.ok((await req(cs.json.files[0].preview_url, staff)).bytes.equals(PDF), "and for staff");
      assert.equal((await req("/api/admin/records/cases/case-1/files", staff)).status, 404, "staff never reach a workspace's files");
      assert.equal(fetched.length - before, 1, "fetched once, then served from the cache");
      assert.ok(walk(path.join(TMP, "objects")).some((f) => f.includes(`documents${path.sep}shared${path.sep}`)), "kept in the shared store");
      const page = await req("/api/records/instruments/page-1/files", viewerA);
      assert.equal(page.json.files[0].preview, "html");
      const pageShown = await req(page.json.files[0].preview_url, viewerA);
      assert.ok(!/<script|tracker\.example/.test(pageShown.bytes.toString()), "a fetched page is sanitised too");
      const off = await req("/api/records/instruments/off-1/files", viewerA);
      assert.equal(off.json.files[0].preview_url, null); assert.match(off.json.files[0].error, /not one of the hosts/);
      const gone = await req("/api/records/instruments/gone-1/files", viewerA);
      assert.match(gone.json.files[0].error, /answered 404/);
      // A workspace area's document is the workspace's own: sealed under its prefix, a data trail entry.
      await withTenant(A.orgId, () => recs.update("cases", "case-1", { title: "Case one", data: { subject: "Notice", files: [pdfRef, pngRef, htmlRef, txtRef, xlsRef], link: "https://www.regs.example/c2.pdf" } }));
      const wc = await req("/api/records/cases/case-1/files", memberA);
      const linkCard = wc.json.files.find((c: any) => c.source === "document");
      assert.ok((await req(linkCard.preview_url, memberA)).bytes.equals(PDF));
      const wsDoc = walk(path.join(TMP, "objects")).filter((f) => f.includes(`org-${A.orgId}${path.sep}.documents${path.sep}`));
      assert.equal(wsDoc.length, 2, "its copy and its note, under A's prefix");
      for (const f of wsDoc) assert.ok(!readFileSync(f).includes("%PDF") && !readFileSync(f).includes("regs.example"), "sealed");
      ok("URL documents: only listed hosts (and subdomains), https on 443, no credentials or addresses, no redirect off the list, no private address; size and type checked; cached once and served to every workspace and staff for a shared area, sealed per workspace for its own; a failure said on the card");
    }

    // ---------- 8. uploads from the console (mold_v0-238) ----------
    {
      const UP = Buffer.concat([PDF, Buffer.from(`% upload ${MARK}\n`)]);
      // The bytes as they are (the world's req sends JSON).
      const raw = (method: string, p: string, h: Record<string, string>, body: Buffer) => fetch(`${http.base}${p}`, { method, headers: h, body });
      const up = (key: string, field: string, tok: string, body: Buffer, h: Record<string, string> = {}) =>
        raw("POST", `/api/data/cases/${key}/files/${field}`, { authorization: `Bearer ${tok}`, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("Révision ../notice.pdf"), "x-file-type": "application/pdf", ...h }, body);
      const r1 = await up("case-9", "files", memberA, UP);
      const ref = await r1.json() as any;
      assert.equal(r1.status, 201, JSON.stringify(ref));
      assert.deepEqual([ref.name, ref.size, ref.content_type], ["notice.pdf", UP.length, "application/pdf"], "its name without directories, its size, the type its bytes say");
      assert.match(ref.object, /^rf_[0-9a-f]{32}$/);
      const kept = walk(path.join(TMP, "objects")).filter((f) => f.includes(ref.object));
      assert.equal(kept.length, 1); assert.ok(!readFileSync(kept[0]!).includes(MARK), "sealed at rest");
      const r2 = await (await up("case-9", "cover", memberA, PNG, { "x-file-name": "cover.png", "x-file-type": "image/png" })).json() as any;
      // Refusals: not bytes, a field that takes none, a role that may not write, a shared area, another area's field.
      assert.equal((await up("case-9", "files", memberA, UP, { "content-type": "application/json" })).status, 415, "bytes only as application/octet-stream");
      assert.equal((await up("case-9", "subject", memberA, UP)).status, 404, "a text field takes no file");
      assert.equal((await up("case-9", "nothing", memberA, UP)).status, 404, "no such field");
      assert.equal((await up("case-9", "files", viewerA, UP)).status, 403, "a role the area does not let write");
      assert.equal((await raw("POST", "/api/data/instruments/i-1/files/url", { authorization: `Bearer ${ownerA}`, "content-type": "application/octet-stream" }, UP)).status, 404, "a shared area takes no upload");
      assert.equal((await up("bad key!", "files", memberA, UP)).status, 400, "a record key");
      assert.equal((await up("case-9", "files", memberA, Buffer.alloc(0))).status, 400, "an empty file");
      const big = await up("case-9", "files", memberA, Buffer.alloc(files.recordUploadMax() + 1));
      assert.equal(big.status, 413, "over the upload limit");
      // The create writes the references; the record's cards open them, byte for byte.
      const made = await http.req("POST", "/api/data/cases", { authorization: `Bearer ${memberA}`, "x-pack-request": "1" }, { key: "case-9", title: "Uploaded", data: { subject: "From the console", files: [ref], cover: r2 } });
      assert.equal(made.status, 201, await made.text());
      const cards9 = await req("/api/records/cases/case-9/files", memberA);
      assert.deepEqual(cards9.json.files.map((c: any) => [c.field, c.name, c.preview]), [["files", "notice.pdf", "pdf"], ["cover", "cover.png", "image"]]);
      assert.ok((await req(cards9.json.files[0].download_url, memberA)).bytes.equals(UP), "the upload's bytes intact");
      // Uploaded for another key: written into case-9 it opens nothing (bound to the key it was kept for).
      const other = await (await up("case-10", "files", memberA, UP)).json() as any;
      // Removing: never one the record holds, never another key's, once.
      const del = (key: string, field: string, tok: string, body: unknown) => http.req("DELETE", `/api/data/cases/${key}/files/${field}`, { authorization: `Bearer ${tok}` }, body);
      assert.equal((await del("case-9", "files", memberA, ref)).status, 409, "the record holds it");
      assert.equal((await del("case-9", "files", memberA, other)).status, 404, "another key's file is not this key's");
      assert.equal((await del("case-10", "files", ownerB, other)).status, 404, "another workspace never finds it");
      assert.equal((await del("case-10", "files", viewerA, other)).status, 403, "a role that may not write");
      assert.equal((await del("case-10", "files", memberA, { object: "x" })).status, 400, "a reference, as the upload answered it");
      assert.equal((await del("case-10", "files", memberA, other)).status, 204, "one kept but never written");
      assert.equal(walk(path.join(TMP, "objects")).filter((f) => f.includes(other.object)).length, 0, "and gone");
      assert.equal((await del("case-10", "files", memberA, other)).status, 404, "once");
      await audit.flushAudit();
      const trail = await db.query<{ action: string; record_key: string }>("SELECT action, record_key FROM audit_data_events WHERE org_id = $1 AND target = 'file' AND action IN ('create', 'delete') ORDER BY seq", [A.orgId]);
      assert.deepEqual(trail.map((t) => `${t.action} ${t.record_key}`), ["create case-9:files", "create case-9:cover", "create case-10:files", "delete case-10:files"], JSON.stringify(trail));
      assert.ok(!JSON.stringify(trail).includes("notice"), "the place, never the name");
      // Off with document previews (mold_v0-219): no upload.
      const F = await import("../src/features.js");
      F.setFeaturesForTest({ document_preview: false });
      assert.equal((await up("case-11", "files", memberA, UP)).status, 404, "document_preview off: no upload");
      F.setFeaturesForTest(null);
      ok("uploads: kept sealed for the record's key and answered as the reference the create writes; bytes only, a file field of a workspace area, a role that writes it, the size limit; one kept but never written removed (never one the record holds or another key's); create and delete of a file in the data trail; off with document_preview");
    }

    // ---------- 9. a url field (mold_v0-238) ----------
    {
      const put = (data: Record<string, unknown>) => http.req("PUT", "/api/data/cases/case-9", { authorization: `Bearer ${memberA}`, "x-pack-request": "1" }, { title: "Uploaded", data: { subject: "From the console", ...data } });
      for (const bad of ["regs.example/c2.pdf", "ftp://regs.example/x", "javascript:alert(1)", "https://u:p@regs.example/x", "https:///x"]) {
        const r = await put({ home: bad });
        assert.equal(r.status, 400, bad); assert.match(await r.text(), /field home of area cases must be an http or https address/);
      }
      assert.equal((await put({ home: "https://regs.example/about", site: "https://www.regs.example/c2.pdf" })).status, 200);
      const wc = await req("/api/records/cases/case-9/files", memberA);
      const site = wc.json.files.find((c: any) => c.field === "site");
      assert.deepEqual([site.source, site.name, site.preview], ["document", "c2.pdf", "pdf"], "a url field's document is a card");
      assert.ok(!wc.json.files.some((c: any) => c.field === "home"), "an address that previews nothing is no card");
      const mcp = await connect({ ...A, role: "member" } as never);
      const { tools } = await mcp.client.listTools();
      const update = tools.find((t: any) => t.name === "filefix_update_cases") as any;
      assert.equal(update?.inputSchema?.properties?.data?.properties?.home?.type, "string", "the tool takes an address as text");
      const refused = await mcp.call("filefix_update_cases", { key: "case-9", title: "Uploaded", data: { subject: "x", home: "ftp://regs.example/x" } });
      assert.ok(refused.isError, `the tool refuses an address that is not one: ${JSON.stringify(refused).slice(0, 200)}`);
      await mcp.close();
      ok("a url field: an http or https address with a host and no credentials, checked on write; its document a card when it previews one");
    }

    // ---------- 10. an area's own lists (mold_v0-237) ----------
    {
      const spec = await req("/api/tab-actions/_areas/cases", memberA);
      assert.equal(spec.status, 200, JSON.stringify(spec.json));
      assert.deepEqual([spec.json.kind, spec.json.label, spec.json.allowed, spec.json.area.name, spec.json.upload_max], ["create_record", "Add case", true, "cases", files.recordUploadMax()]);
      assert.deepEqual(spec.json.area.fields.filter((f: any) => ["files", "site"].includes(f.name)).map((f: any) => [f.name, f.type, f.multiple, f.preview ?? null]), [["files", "file", true, null], ["site", "url", false, "document"]]);
      assert.equal((await req("/api/tab-actions/_areas/cases", viewerA)).json.allowed, false, "a role that may not add sees no button");
      assert.equal((await req("/api/tab-actions/_areas/instruments", memberA)).status, 404, "a shared area's lists have none");
      const cards = await req("/api/records/_console/cases/sparklines", memberA);
      assert.equal(cards.status, 200, JSON.stringify(cards.json));
      assert.equal(cards.json.cards.length, 4, "its four cards");
      assert.equal((await req("/api/records/_console/cases/sparklines", ownerB)).json.cards[0].value, 1, "a workspace's own numbers (B has one case)");
      ok("an area's own lists: the create action its people may use (labelled, its fields, the upload limit), none for a shared area; its four cards for the workspace");
    }

    assert.ok(!printed.includes(MARK), "no file's bytes in the logs");
  } finally {
    await http.close();
    host.close();
  }
  console.log(`record files: all ${n} sections passed`);
} finally {
  cleanup();
}
process.exit(0);
