// The share image (mold_v0-093; scripts/gen-packs.mjs, web/src/features/site/share-image.tsx, web/src/app/opengraph-image.tsx
// and twitter-image.tsx), offline: no database, no server, no browser.
//   npm run test:share-image                         SHARE_IMAGE_SHOTS=<dir> also keeps the rendered PNGs there
//
// 1. gen-packs: with no brand picture the share image is drawn from the build's words: the landing block's headline (else
//    the profile's tagline), its sub-headline (else the console's description unless it repeats the headline) and the
//    profile's name, with an alternative text in the same words; a brand's own picture (brand/share-image.png, which the
//    factory's branding step copies) is embedded byte for byte with the console's description as its text; a picture of
//    another size, another format, too large, or a link is refused with its path.
// 2. The image, rendered as the console's routes render it (the route module bundled with esbuild, next/og as installed):
//    a 1200x630 PNG answered as image/png for the neutral shell and a branded build, in the build's colour and mark; the
//    brand's own picture is answered with exactly its bytes.
// 3. No product word (scripts/vocabulary.json) in a drawn image's words or text, and the shell carries no picture of a
//    product: no static share image beside the routes, which take their alternative text, size and type from one place.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "share-image-test-"));
const SHOTS = process.env.SHARE_IMAGE_SHOTS ? path.resolve(process.env.SHARE_IMAGE_SHOTS) : null;
const WORDS: string[] = JSON.parse(readFileSync(path.join(ROOT, "scripts", "vocabulary.json"), "utf8")).words;

type Spec = { alt: string; name: string; headline: string; subheadline: string | null; brand: { png: string; sha256: string } | null };
const specOf = (out: string): Spec =>
  JSON.parse(/export const shareImage: ShareImageSpec = ([\s\S]*?);\n/.exec(readFileSync(path.join(out, "web", "src", "config", "share-image.generated.ts"), "utf8"))![1]!);

/** A PNG of w x h in one colour (standard library only). */
function png(w: number, h: number, rgb: [number, number, number] = [18, 52, 86]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, "latin1"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const dims = (b: Buffer) => ({ png: b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), width: b.readUInt32BE(16), height: b.readUInt32BE(20) });
const noProductWord = (what: string, text: string) => {
  for (const w of WORDS) assert.ok(!text.toLowerCase().includes(w.toLowerCase()), `${what}: no product word (${w}) in ${JSON.stringify(text.slice(0, 200))}`);
};

try {
  // ---------- the copy: the codebase without its packs, node_modules linked ----------
  const copy = path.join(TMP, "copy");
  const skip = new Set(["node_modules", ".pglite", ".git", ".next", "brand"]);
  cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
  for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
  mkdirSync(path.join(copy, "packs"), { recursive: true });
  const gen = (prof: object, extra: string[] = []) => {
    writeFileSync(path.join(copy, "profile.json"), JSON.stringify(prof));
    return spawnSync(process.execPath, [path.join(copy, "scripts", "gen-packs.mjs"), ...extra], { cwd: copy, encoding: "utf8" });
  };

  // ---------- 1. gen-packs ----------
  let g = gen({});
  assert.equal(g.status, 0, g.stderr);
  const neutral = specOf(copy);
  assert.deepEqual(neutral, { alt: "Workspace: Connect an MCP client, run agents and read their results.", name: "Workspace", headline: "Connect an MCP client, run agents and read their results.", subheadline: null, brand: null },
    "the neutral shell: its name and tagline (the console's description only repeats it)");
  assert.equal(readFileSync(path.join(ROOT, "web", "src", "config", "share-image.generated.ts"), "utf8"), readFileSync(path.join(copy, "web", "src", "config", "share-image.generated.ts"), "utf8"),
    "the shell's own generated module is the neutral one");

  const ACME = { name: "Acme Ops", console_title: "Acme Ops", short_description: "Tools for small teams.", console_description: "Acme Ops — Tools for small teams." };
  g = gen(ACME);
  assert.equal(g.status, 0, g.stderr);
  const acme = specOf(copy);
  assert.deepEqual([acme.name, acme.headline, acme.subheadline, acme.alt], ["Acme Ops", "Tools for small teams.", null, "Acme Ops: Tools for small teams."], `a brand's words: ${JSON.stringify(acme)}`);
  g = gen({ ...ACME, landing: { hero: { headline: "Audits that finish themselves", subheadline: "Every control, its evidence and its owner in one place." } } });
  assert.equal(g.status, 0, g.stderr);
  const landed = specOf(copy);
  assert.deepEqual([landed.headline, landed.subheadline, landed.alt], ["Audits that finish themselves", "Every control, its evidence and its owner in one place.",
    "Acme Ops: Audits that finish themselves. Every control, its evidence and its owner in one place."], `the landing block's hero: ${JSON.stringify(landed)}`);
  // A headline with a highlighted end (sections, mold_v0-122): the picture says the whole of it, as the page does (mold_v0-138).
  g = gen({ ...ACME, landing: { sections: [{ type: "hero", headline: "Audits that cite", headline_highlight: "the control.", subheadline: "Every finding, its control." }] } });
  assert.equal(g.status, 0, g.stderr);
  const highlighted = specOf(copy);
  assert.deepEqual([highlighted.headline, highlighted.alt], ["Audits that cite the control.", "Acme Ops: Audits that cite the control. Every finding, its control."], `the whole headline: ${JSON.stringify(highlighted)}`);

  const brandPng = png(1200, 630, [200, 30, 90]);
  const brandFile = path.join(TMP, "share-image.png");
  writeFileSync(brandFile, brandPng);
  g = gen(ACME, ["--share-image", brandFile]);
  assert.equal(g.status, 0, g.stderr);
  const branded = specOf(copy);
  assert.ok(branded.brand && Buffer.from(branded.brand.png, "base64").equals(brandPng) && branded.brand.sha256 === createHash("sha256").update(brandPng).digest("hex"),
    "the brand's own picture is embedded byte for byte, with its hash");
  assert.equal(branded.alt, ACME.console_description, "its alternative text is the console's description");
  mkdirSync(path.join(copy, "brand"));
  writeFileSync(path.join(copy, "brand", "share-image.png"), brandPng);
  g = gen(ACME);
  assert.ok(g.status === 0 && specOf(copy).brand?.sha256 === branded.brand!.sha256, "read from brand/share-image.png, where the branding step puts it");
  rmSync(path.join(copy, "brand"), { recursive: true });
  const refused = (what: string, file: string, re: RegExp) => {
    const r = gen(ACME, ["--share-image", file]);
    assert.ok(r.status !== 0 && re.test(r.stderr), `${what}: refused with ${re} (got ${r.status}: ${r.stderr.slice(0, 400)})`);
  };
  writeFileSync(path.join(TMP, "small.png"), png(600, 315));
  refused("another size", path.join(TMP, "small.png"), /small\.png: the brand's share image is 600x315: it must be 1200x630/);
  writeFileSync(path.join(TMP, "fake.png"), Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64)]));
  refused("another format", path.join(TMP, "fake.png"), /must be a PNG/);
  writeFileSync(path.join(TMP, "big.png"), Buffer.concat([brandPng, Buffer.alloc(1024 * 1024)]));
  refused("over 1 MB", path.join(TMP, "big.png"), /at most 1024 KB/);
  symlinkSync(brandFile, path.join(TMP, "link.png"));
  refused("a link", path.join(TMP, "link.png"), /must be a file \(not a link/);
  console.log("✓ gen-packs: the drawn image's words from the profile and the landing block, the brand's picture embedded as it is, bad pictures refused");

  // ---------- 2. the image, rendered as the routes render it ----------
  const web = path.join(copy, "web");
  const { build } = await import("esbuild");
  const render = async (label: string, prof: object, opts: { share?: string; theme?: string } = {}) => {
    const g2 = gen(prof, opts.share ? ["--share-image", opts.share] : []);
    assert.equal(g2.status, 0, `gen-packs (${label}): ${g2.stderr}`);
    const manifest = path.join(web, "src", "app", "manifest.ts");
    const shellManifest = readFileSync(path.join(ROOT, "web", "src", "app", "manifest.ts"), "utf8");
    writeFileSync(manifest, opts.theme ? shellManifest.replace("theme_color: '#3ecf8e',", `theme_color: '${opts.theme}',`) : shellManifest);
    const entry = path.join(web, "share-entry.ts");
    writeFileSync(entry, `import { writeFileSync } from 'node:fs';
import * as og from '@/app/opengraph-image';
import * as tw from '@/app/twitter-image';
const write = async (r: Response, file: string) => { writeFileSync(file, Buffer.from(await r.arrayBuffer())); return { type: r.headers.get('content-type'), cache: r.headers.get('cache-control') }; };
void (async () => {
  const [file] = process.argv.slice(2);
  const a = await write(await og.default(), file + '.og.png');
  const b = await write(await tw.default(), file + '.tw.png');
  process.stdout.write('\\u0001' + JSON.stringify({ og: { ...a, alt: og.alt, size: og.size, contentType: og.contentType }, tw: { ...b, alt: tw.alt, size: tw.size, contentType: tw.contentType } }));
})();
`);
    const bundle = path.join(web, `share-render-${label}.cjs`);
    await build({ entryPoints: [entry], bundle: true, format: "cjs", platform: "node", outfile: bundle, absWorkingDir: web, tsconfig: path.join(web, "tsconfig.json"), jsx: "automatic",
      external: ["next/og", "next"], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error" });
    rmSync(entry, { force: true });
    const file = path.join(TMP, `share-${label}`);
    const r = spawnSync(process.execPath, [bundle, file], { cwd: web, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
    rmSync(bundle, { force: true });
    assert.equal(r.status, 0, `render (${label}): ${(r.stderr ?? "").slice(0, 2000)}`);
    const meta = JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1));
    const og = readFileSync(`${file}.og.png`), tw = readFileSync(`${file}.tw.png`);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); cpSync(`${file}.og.png`, path.join(SHOTS, `${label}-opengraph-image.png`)); cpSync(`${file}.tw.png`, path.join(SHOTS, `${label}-twitter-image.png`)); }
    writeFileSync(manifest, shellManifest);
    return { og, tw, meta };
  };
  const check = (label: string, r: Awaited<ReturnType<typeof render>>, alt: string) => {
    for (const [k, img] of [["og", r.og], ["tw", r.tw]] as const) {
      assert.deepEqual(dims(img), { png: true, width: 1200, height: 630 }, `${label} ${k}: a 1200x630 PNG`);
      assert.equal(r.meta[k].type, "image/png", `${label} ${k}: answered as image/png`);
      assert.deepEqual(r.meta[k].size, { width: 1200, height: 630 }, `${label} ${k}: the route says its size`);
      assert.equal(r.meta[k].contentType, "image/png", `${label} ${k}: the route says its type`);
      assert.equal(r.meta[k].alt, alt, `${label} ${k}: the route's alternative text`);
    }
    assert.ok(r.og.equals(r.tw), `${label}: the X card is the same picture`);
  };
  const n = await render("zero-pack", {});
  check("zero-pack", n, neutral.alt);
  const a = await render("branded", { ...ACME, landing: { hero: { headline: "Audits that finish themselves", subheadline: "Every control, its evidence and its owner in one place." } } }, { theme: "#1F6F5C" });
  check("branded", a, landed.alt);
  assert.ok(!a.og.equals(n.og), "another build's words and colour: another picture");
  const b = await render("brand-picture", ACME, { share: brandFile });
  check("brand-picture", b, ACME.console_description);
  assert.ok(b.og.equals(brandPng) && b.tw.equals(brandPng), "the brand's own picture is answered with exactly its bytes");
  console.log("✓ the routes: a 1200x630 PNG as image/png in the build's words, colour and mark; the brand's picture byte for byte");

  // ---------- 3. no product's words or picture in the shell ----------
  for (const [what, s] of [["neutral", neutral], ["branded", acme], ["landing", landed]] as const)
    for (const t of [s.alt, s.name, s.headline, s.subheadline ?? ""]) noProductWord(`${what} share image`, t);
  const app = path.join(ROOT, "web", "src", "app");
  const statics = readdirSync(app).filter((f) => /^(opengraph|twitter)-image\.(png|jpe?g|gif|alt\.txt)$/.test(f));
  assert.deepEqual(statics, [], "no static share image or alternative text beside the routes (another product's picture was one)");
  for (const f of ["opengraph-image.tsx", "twitter-image.tsx"]) {
    const src = readFileSync(path.join(app, f), "utf8");
    assert.ok(/export const alt = shareImageAlt;/.test(src) && /export const size = SHARE_IMAGE_SIZE;/.test(src) && /return renderShareImage\(\);/.test(src), `${f}: the shared renderer and its words`);
  }
  console.log("✓ no product word in a drawn share image; no product picture in the shell");
  console.log("share-image test: ok");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
