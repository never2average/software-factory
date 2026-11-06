// A workspace's own agent icon (mold_v0-252; src/agent-icon.ts, src/agent-routes.ts /api/agent/icon), offline: an
// embedded database, the stand-in Clerk and a local object store.
//   npm run test:agent-icon
//
//  1. Off (the default): /api/agent/icon answers not found.
//  2. Validation, pure: a malicious SVG is sanitised (script, handlers, foreignObject, style sheet, outside links and
//     pictures gone, its drawing kept, one colour redrawn in currentColor); an SVG of two colours keeps them; a DOCTYPE
//     or entity, no viewBox, nothing left to draw, a file over 256 KB, a GIF or a text file are refused; a PNG (every
//     colour type the browser makes) is trimmed and fitted inside 64 px and re-encoded with nothing of the original's
//     other chunks; a JPG or WebP is kept only at most 64 px a side; what a file is comes from its bytes.
//  3. Over HTTP: an owner uploads (PUT), every person of the workspace reads it (GET), a member or viewer may not change
//     it (403); an oversized body is refused (413) and nothing changes; bytes that are not an icon (400); reset (DELETE)
//     goes back to none (the app's).
//  4. Isolation: workspace B never sees A's icon (its own GET answers none, its reset leaves A's); A's sealed object is
//     under A's prefix only, does not open as B's (copied under B's prefix it is not B's icon), and holds no readable
//     byte of the SVG.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
process.env.APP_SCHEDULER = "off";
let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };

const EVIL = `<?xml version="1.0"?>
<!-- a comment <script>x()</script> -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="32" height="32" onload="alert(1)">
  <script>alert(2)</script>
  <style>path{fill:url(https://evil.example/x)}</style>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(5)">hi</div></foreignObject>
  <a xlink:href="javascript:alert(3)"><path d="M0 0h4v4z"/></a>
  <image href="https://evil.example/p.png" width="4" height="4"/>
  <use xlink:href="https://evil.example/s.svg#x"/>
  <use href="#ok"/>
  <path id="ok" d="M2 2h28v28H2z" fill="#112233" onclick="alert(4)" ONMOUSEOVER="alert(6)" style="stroke:#112233;fill:url(https://evil.example/y)" transform="java&#115;cript:x"/>
  <circle cx="16" cy="16" r="6" fill="#123" filter="url(https://evil.example/f)"/>
</svg>`;

/** A PNG of w x h RGBA pixels from `px(x, y)`, with an extra text chunk (to see it is not carried). */
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number, number], ctype = 6): Buffer {
  const crcT = new Uint32Array(256).map((_, k) => { let c = k; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (k: string, body: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(body.length); const kb = Buffer.from(k, "latin1"); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([kb, body]))); return Buffer.concat([l, kb, body, c]); };
  const ch = ctype === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ctype;
  const rows = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w * ch + 1)] = y % 2 ? 2 : 0;     // an Up filter on odd rows: the decoder must undo it
    for (let x = 0; x < w; x++) {
      const v = px(x, y), o = y * (w * ch + 1) + 1 + x * ch;
      for (let c = 0; c < ch; c++) rows[o + c] = v[c]!;
    }
  }
  // the Up filter's deltas on odd rows (from the last row up, so each row's original is still above it)
  for (let y = h - 1; y > 0; y--) if (y % 2) for (let k = 1; k <= w * ch; k++) rows[y * (w * ch + 1) + k] = (rows[y * (w * ch + 1) + k]! - rows[(y - 1) * (w * ch + 1) + k]! + 256) & 0xff;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("tEXt", Buffer.from("Comment\0SECRET-METADATA")), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

try {
  const F = await import("../src/features.js");
  const I = await import("../src/agent-icon.js");
  const { agentAppRouter } = await import("../src/agent-routes.js");
  const { createOrg } = await import("../src/auth.js");
  const stack = (r: unknown) => ((r as { stack?: unknown[] }).stack ?? []).length;

  // ---------- 1. off ----------
  F.setFeaturesForTest({});
  assert.equal(stack(agentAppRouter()), 0);
  ok("off: no /api/agent route, so no icon route");

  // ---------- 2. validation ----------
  {
    const k = I.checkAgentIcon(Buffer.from(EVIL), "image/png");     // the declared type is not believed
    const svg = Buffer.from(k.data, "base64").toString("utf8"), low = svg.toLowerCase();
    assert.equal(k.content_type, "image/svg+xml");
    for (const bad of ["script", "onload", "onclick", "onmouseover", "foreignobject", "javascript", "evil.example", "<image", "<a ", "<style", "alert", "filter", "comment", "<?xml"])
      assert.ok(!low.includes(bad), `the cleaned SVG still has ${bad}: ${svg}`);
    assert.ok(svg.includes("<path") && svg.includes("<circle") && svg.includes('<use href="#ok"/>') && svg.includes('viewBox="0 0 32 32"'), svg);
    assert.ok(k.follows_color && !svg.includes("#112233") && svg.split("currentColor").length - 1 >= 3, `one colour becomes currentColor: ${svg}`);
    assert.deepEqual(I.sanitiseSvg(Buffer.from(svg)).svg, svg, "a cleaned SVG cleans to itself");
    ok("a malicious SVG is sanitised: script, handlers, foreignObject, style sheet, outside links and pictures, comments gone; its drawing kept, one colour redrawn in currentColor");
    const two = I.checkAgentIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="4" height="4" fill="#f00"/><rect x="4" width="4" height="4" style="fill: #00f"/></svg>'));
    assert.ok(!two.follows_color && Buffer.from(two.data, "base64").toString().includes("#00f"));
    const none = I.checkAgentIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="4" height="4"/></svg>'));
    assert.ok(none.follows_color && Buffer.from(none.data, "base64").toString().includes('fill="currentColor"'));
    ok("an SVG of two colours keeps them (a picture); one with no colour is painted in currentColor");
    const refused: [Buffer, number, RegExp][] = [
      [Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><text>&x;</text></svg>'), 400, /DOCTYPE/],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'), 400, /viewBox/],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>x()</script><foreignObject/></svg>'), 400, /nothing is left/],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><g><rect/></svg>'), 400, /XML/],
      [Buffer.from('<html><svg viewBox="0 0 8 8"><rect/></svg></html>'), 400, /root element/],
      [Buffer.concat([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="4" height="4"/><!--'), Buffer.alloc(I.AGENT_ICON_MAX_BYTES, 32), Buffer.from("--></svg>")]), 413, /at most 256 KB/],
      [Buffer.from("GIF89a" + "\0".repeat(40)), 400, /an SVG, a PNG, a JPG or a WebP/],
      [Buffer.from("hello, not a picture"), 400, /an SVG, a PNG, a JPG or a WebP/],
      [Buffer.alloc(0), 400, /empty/],
    ];
    for (const [b, status, why] of refused) {
      assert.throws(() => I.checkAgentIcon(b), (e: { status?: number; message: string }) => e.status === status && why.test(e.message), `${why}`);
    }
    ok("refused: a DOCTYPE or entity, no viewBox, nothing left to draw, tags not nested, a root that is not <svg>, over 256 KB (413), a GIF, text, nothing");
    const big = png(300, 200, (x, y) => (x < 20 || y < 20 ? [0, 0, 0, 0] : [200, 30, 30, 255]));
    const p = I.checkAgentIcon(big);
    const kept = Buffer.from(p.data, "base64"), dec = I.decodePng(kept);
    assert.equal(p.content_type, "image/png");
    assert.ok(Math.max(p.width!, p.height!) === 64 && p.width === dec.w && p.height === dec.h, `${p.width}x${p.height}`);
    assert.ok(Math.abs(p.width! / p.height! - 280 / 180) < 0.05, "trimmed of its transparent margin, the aspect kept");
    assert.ok(!kept.includes(Buffer.from("SECRET-METADATA")) && !kept.includes(Buffer.from("tEXt")), "nothing but the pixels is carried");
    assert.deepEqual([...dec.px.subarray(0, 4)], [200, 30, 30, 255]);
    const rgb = I.checkAgentIcon(png(10, 10, () => [1, 2, 3, 255], 2));
    assert.ok(rgb.width === 10 && I.decodePng(Buffer.from(rgb.data, "base64")).px[3] === 255, "a small RGB PNG is kept at its size");
    ok("a PNG is decoded, trimmed and fitted inside 64 px, and re-encoded with nothing of the original but its pixels");
    const jpeg = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0xff, 0xd9]);
    assert.equal(I.checkAgentIcon(jpeg(48, 40)).content_type, "image/jpeg");
    assert.throws(() => I.checkAgentIcon(jpeg(640, 480)), /640x480: send a PNG/);
    const webp = Buffer.alloc(40); webp.write("RIFF", 0, "latin1"); webp.write("WEBP", 8, "latin1"); webp.write("VP8X", 12, "latin1"); webp.writeUIntLE(31, 24, 3); webp.writeUIntLE(31, 27, 3);
    assert.equal(I.checkAgentIcon(webp).content_type, "image/webp");
    webp.writeUIntLE(999, 24, 3);
    assert.throws(() => I.checkAgentIcon(webp), /1000x32: send a PNG/);
    ok("a JPG or WebP is kept only at most 64 px a side (the console resizes every picture first); its size from its header");
  }

  // ---------- 3 and 4. over HTTP, and isolation ----------
  F.setFeaturesForTest({ agent_harness: true });
  {
    const A = (await createOrg(`Icon A ${STAMP}`)).org, B = (await createOrg(`Icon B ${STAMP}`)).org;
    const http = await startHttp();
    const ownerA = await http.signIn(A, "owner"), memberA = await http.signIn(A, "member"), viewerA = await http.signIn(A, "viewer");
    const ownerB = await http.signIn(B, "owner");
    const h = (t: string) => ({ authorization: `Bearer ${t}` });
    const put = (t: string, body: Buffer | string, type = "application/octet-stream") =>
      fetch(`${http.base}/api/agent/icon`, { method: "PUT", headers: { ...h(t), "content-type": type, "x-file-type": "image/svg+xml" }, body: typeof body === "string" ? body : new Uint8Array(body) });
    const get = async (t: string) => { const r = await http.req("GET", "/api/agent/icon", h(t)); assert.equal(r.status, 200); return r.json() as Promise<{ icon: { content_type: string; data: string; sha256: string } | null; can_change: boolean }>; };

    assert.deepEqual(await get(ownerA), { icon: null, can_change: true, max_bytes: I.AGENT_ICON_MAX_BYTES });
    assert.equal((await get(memberA)).can_change, false);
    let r = await put(memberA, EVIL);
    assert.equal(r.status, 403, "a member may not change it");
    r = await put(viewerA, EVIL);
    assert.equal(r.status, 403, "a viewer may not change it");
    r = await put(ownerA, EVIL, "image/svg+xml");
    assert.equal(r.status, 415, "only as application/octet-stream");
    r = await put(ownerA, EVIL);
    assert.equal(r.status, 200, await r.clone().text());
    const mine = (await r.json() as { icon: { sha256: string; data: string; updated_by: string | null } }).icon;
    assert.ok(!Buffer.from(mine.data, "base64").toString().includes("script") && mine.updated_by);
    for (const t of [ownerA, memberA, viewerA]) assert.equal((await get(t)).icon?.sha256, mine.sha256, "every person of the workspace sees it");
    ok("over HTTP: an owner uploads (sanitised on the way in), every person of the workspace reads it, a member or viewer may not change it");

    r = await put(ownerA, Buffer.alloc(I.AGENT_ICON_MAX_BYTES + 1, 0x20));
    assert.equal(r.status, 413, "an oversized file is refused");
    assert.match((await r.json() as { error: string }).error, /at most 256 KB/);
    r = await put(ownerA, Buffer.from("GIF89a" + "\0".repeat(40)));
    assert.equal(r.status, 400);
    assert.equal((await get(ownerA)).icon?.sha256, mine.sha256, "a refused upload changes nothing");
    ok("an oversized file is refused (413) and a file that is no icon (400); the icon kept is unchanged");

    // Isolation: B sees none of A's; B's reset leaves A's; A's object is A's alone.
    assert.equal((await get(ownerB)).icon, null, "workspace B never sees A's icon");
    r = await http.req("DELETE", "/api/agent/icon", h(ownerB));
    assert.equal(r.status, 200);
    assert.equal((await get(ownerA)).icon?.sha256, mine.sha256, "B's reset does not touch A's");
    const objects = path.join(TMP, "objects");
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.relative(objects, path.join(d, e.name))); };
    walk(objects);
    const iconFiles = files.filter((f) => f.includes(".agent-icon"));
    assert.deepEqual(iconFiles, [`workspaces/org-${A.orgId}/.agent-icon/icon.wse`], "A's icon is under A's prefix only");
    const sealed = readFileSync(path.join(objects, iconFiles[0]!));
    assert.ok(!sealed.includes(Buffer.from("<svg")) && !sealed.includes(Buffer.from(mine.data.slice(0, 24))), "sealed: no readable byte of the icon");
    mkdirSync(path.join(objects, `workspaces/org-${B.orgId}/.agent-icon`), { recursive: true });
    copyFileSync(path.join(objects, iconFiles[0]!), path.join(objects, `workspaces/org-${B.orgId}/.agent-icon/icon.wse`));
    assert.equal(await I.readAgentIcon(B.orgId), null, "A's sealed icon copied under B's prefix does not open as B's");
    assert.equal((await get(ownerB)).icon, null);
    ok("isolation: workspace B never sees A's icon (its GET answers none, its reset leaves A's); A's object sits under A's prefix only, sealed, and does not open as B's");

    const pngBody = png(128, 128, (x, y) => ((x - 64) ** 2 + (y - 64) ** 2 < 3000 ? [10, 120, 200, 255] : [0, 0, 0, 0]));
    r = await put(ownerB, pngBody);
    assert.equal(r.status, 200);
    const bIcon = (await r.json() as { icon: { content_type: string; width: number } }).icon;
    assert.ok(bIcon.content_type === "image/png" && bIcon.width <= 64);
    assert.equal((await get(ownerA)).icon?.sha256, mine.sha256, "B's own icon is B's alone");
    r = await http.req("DELETE", "/api/agent/icon", h(memberA));
    assert.equal(r.status, 403, "a member may not reset it");
    r = await http.req("DELETE", "/api/agent/icon", h(ownerA));
    assert.equal(r.status, 200);
    assert.equal((await get(ownerA)).icon, null, "reset: back to the app's icon");
    assert.ok(!existsSync(path.join(objects, `workspaces/org-${A.orgId}/.agent-icon/icon.wse`)));
    assert.equal((await get(ownerB)).icon?.content_type, "image/png", "A's reset leaves B's");
    ok("each workspace its own: B's PNG (fitted inside 64 px) is B's alone; an owner's reset goes back to the app's icon, a member's is refused");
    await http.close();
  }

  F.setFeaturesForTest(null);
  console.log(`\nagent icon: all ${n} checks passed`);
  cleanup();
  process.exit(0);
} catch (e) {
  console.error(e);
  cleanup();
  process.exit(1);
}
