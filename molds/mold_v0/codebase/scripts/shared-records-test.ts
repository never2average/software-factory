// Shared records for staff (mold_v0-271; src/record-files.ts uploadSharedFile, src/record-routes.ts, src/record-page-routes.ts
// staffPageData), offline: an embedded database, the HTTP server, a declared pack with two shared areas and a workspace one.
//   npm run test:shared-records
//
// 1. A file field of a shared (platform) area: the staff form offers its upload (upload_max); staff with the library
//    right upload a PDF for a record (a viewer cannot), write the record with its reference, and its file card serves
//    it, to staff and to a workspace's people who read the area; a file kept but never written is discarded, one the
//    record holds is not; a workspace's own upload route still refuses a shared area.
// 2. A shared record's laid-out page for staff (flag record_pages): its computed facts and related lists over shared
//    areas only (a count of the shared records that cite it; a workspace area's fact and list hidden), its tab asked by
//    id; off (the flag), not found.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const ok = (m: string) => console.log(`✓ ${m}`);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

const PACK = {
  id: "fixture_shared", name: "Fixture shared", version: "0.1.0",
  record_areas: [
    { name: "fx_papers", label: "Papers", role: "source", scope: "platform", fields: [
      { name: "summary", label: "Summary", type: "text" }, { name: "pdf", label: "PDF", type: "file" }],
      detail: { header: { subtitle: "summary", facts: [
        { label: "Cited by kits", computed: { area: "fx_kits", via: "papers", op: "count" } },
        { label: "Used by apps", computed: { area: "fx_apps", via: "paper", op: "count" } }] },
      tabs: [{ label: "Paper", sections: [{ title: "About", fields: ["summary"] }, { title: "Files", files: { fields: ["pdf"] } }] },
        { label: "Cited by", sections: [
          { title: "Kits", related: { area: "fx_kits", via: "papers", columns: ["note"] } },
          { title: "Apps", related: { area: "fx_apps", via: "paper" } }] }] } },
    { name: "fx_kits", label: "Kits", role: "source", scope: "platform", fields: [
      { name: "note", label: "Note", type: "text" }, { name: "papers", label: "Papers", type: "reference", to: "fx_papers", multiple: true }] },
    { name: "fx_apps", label: "Apps", role: "check", scope: "workspace", fields: [{ name: "paper", label: "Paper", type: "reference", to: "fx_papers" }] },
  ],
};

try {
  const F = await import("../src/features.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  setPacksForTest([{ manifest: { id: "fixture_shared", name: "Fixture shared", version: "0.1.0", entry: null, migrations: null, words: {}, dir: TMP }, declared: compileDeclarations(PACK) } as never]);
  F.setFeatureForTest("record_pages", true);
  F.setFeatureForTest("document_preview", true);
  const http = await startHttp();
  const W = (await createOrg(`Shared ${STAMP}`)).org;
  const member = await http.signIn(W, "member");
  const opTok = await http.adminToken("operator"), viewTok = await http.adminToken("viewer");
  const staff = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-app-admin": "1", "x-pack-request": "1" });
  const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };
  const put = (tok: string, p: string, bytes: Buffer, name = "paper.pdf") => fetch(`${http.base}${p}`, { method: "POST", body: new Uint8Array(bytes),
    headers: { ...staff(tok), "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name), "x-file-type": "application/pdf" } });

  // ---------- 1. a shared area's file field ----------
  {
    const form = await json(await http.req("GET", "/api/admin/records/_console/fx_papers/form", staff(opTok)));
    assert.ok(form.upload_max > 0, `the staff form offers the upload (${JSON.stringify(form).slice(0, 200)})`);
    assert.equal((await put(viewTok, "/api/admin/records/fx_papers/react/files/pdf", PDF)).status, 403, "a staff viewer uploads nothing");
    let r = await put(opTok, "/api/admin/records/fx_papers/react/files/pdf", PDF);
    assert.equal(r.status, 201, JSON.stringify(await json(r.clone())));
    const ref = await json(r);
    assert.deepEqual([ref.name, ref.size, ref.content_type], ["paper.pdf", PDF.length, "application/pdf"]);
    // A second kept but never written: discarded; the one the record holds is not.
    const spare = await json(await put(opTok, "/api/admin/records/fx_papers/react/files/pdf", PDF, "spare.pdf"));
    r = await http.req("POST", "/api/admin/data/fx_papers", staff(opTok), { key: "react", title: "ReAct", data: { summary: "Reason, then act.", pdf: ref } });
    assert.ok(r.status < 300, `the record written with its file: ${JSON.stringify(await json(r))}`);
    assert.equal((await http.req("DELETE", "/api/admin/records/fx_papers/react/files/pdf", staff(opTok), spare)).status, 204, "a file never written is discarded");
    assert.equal((await http.req("DELETE", "/api/admin/records/fx_papers/react/files/pdf", staff(opTok), ref)).status, 409, "the file the record holds is not");
    // Its card serves it, to staff and to a workspace's people.
    for (const [who, base, h] of [["staff", "/api/admin/records", staff(opTok)], ["a workspace member", "/api/records", { authorization: `Bearer ${member}`, "x-pack-request": "1" }]] as const) {
      const cards = await json(await http.req("GET", `${base}/fx_papers/react/files`, h));
      const card = cards.files?.[0];
      assert.equal(card?.preview, "pdf", `${who}: its PDF card (${JSON.stringify(cards).slice(0, 300)})`);
      const body = Buffer.from(await (await fetch(`${http.base}${card.download_url}`, { headers: h })).arrayBuffer());
      assert.ok(body.equals(PDF), `${who}: the bytes as uploaded`);
    }
    // A workspace never writes a shared area's files.
    r = await fetch(`${http.base}/api/data/fx_papers/react/files/pdf`, { method: "POST", body: new Uint8Array(PDF), headers: { authorization: `Bearer ${member}`, "x-pack-request": "1", "content-type": "application/octet-stream" } });
    assert.ok(r.status >= 400, `a workspace's upload into a shared area is refused (${r.status})`);
    ok("a shared area's file field: offered on the staff form, uploaded by staff with the library right (not a viewer), written with the record, served by its card to staff and to a workspace's people, discarded when never written, kept when held; never a workspace's upload");
  }

  // ---------- 2. the staff laid-out page ----------
  {
    assert.ok((await http.req("POST", "/api/admin/data/fx_papers", staff(opTok), { key: "other", title: "Other", data: { summary: "Another paper." } })).status < 300);
    for (const [k, papers] of [["kit-a", ["react"]], ["kit-b", ["react", "other"]], ["kit-c", ["other"]]] as const)
      assert.ok((await http.req("POST", "/api/admin/data/fx_kits", staff(opTok), { key: k, title: k, data: { note: `note ${k}`, papers } })).status < 300);
    let page = await json(await http.req("GET", "/api/admin/records/_page/fx_papers/react", staff(viewTok)));
    assert.deepEqual(page.facts["0"], { op: "count", value: 2, capped: false, area: "fx_kits", via: "papers" }, "a computed fact over a shared area: the two kits citing it");
    assert.deepEqual(page.facts["1"], { hidden: true }, "a workspace area's fact: hidden from staff");
    assert.deepEqual(page.sections, {}, "the first tab has no related list");
    page = await json(await http.req("GET", "/api/admin/records/_page/fx_papers/react?tab=cited-by", staff(viewTok)));
    assert.deepEqual(page.sections["1-0"].records.map((x: { key: string }) => x.key).sort(), ["kit-a", "kit-b"], "the related list of shared records that cite it");
    assert.deepEqual(page.sections["1-1"], { hidden: true }, "a workspace area's list: hidden from staff");
    assert.equal((await http.req("GET", "/api/admin/records/_page/fx_papers/nope", staff(viewTok))).status, 404);
    F.setFeatureForTest("record_pages", false);
    assert.equal((await http.req("GET", "/api/admin/records/_page/fx_papers/react", staff(viewTok))).status, 404, "off: not found");
    F.setFeatureForTest("record_pages", true);
    ok("a shared record's laid-out page for staff: computed facts and related lists over shared areas (a workspace area's hidden), its tab by id; not found while record_pages is off");
  }
  await http.close();
  console.log("SHARED RECORDS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
