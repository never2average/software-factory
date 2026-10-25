// The shell pages a build hides from its customer console (mold_v0-130; src/console-pages.ts), offline: build copies
// of the codebase with fixture packs, gen-packs run in each, the console's navigation read through tsx.
//   npm run test:console-hide
//
// 1. Nothing hidden: every generated file is what it was (the sidebar, the tabs, the redirects).
// 2. A pack with tabs hides "activity": its usage tab (which opens /app/activity) leaves the sidebar, the tabs and the
//    customer guide's facts; /app/activity and every address under it redirect to /app; the staff console keeps its
//    Activity page.
// 3. A pack without tabs (the shell's sidebar) and the app's profile.json: the pack hides "activity", the profile
//    "usage" and "billing": all three leave the shell's sidebar and redirect; the rest stays.
// 4. Refused: an id that is not a page, an id twice, an unknown key, in pack.json or profile.json.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "console-hide-"));
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

/** A build copy with these fixture packs (each pack.json edited by `edit`) and profile; gen-packs run. -> the copy, gen's result. */
function buildCopy(name: string, packs: string[], edit: (id: string, j: any) => void = () => {}, profile?: unknown) {
  const copy = path.join(TMP, name);
  const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
  cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
  for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
  mkdirSync(path.join(copy, "packs"), { recursive: true });
  cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
  for (const p of packs) {
    cpSync(path.join(ROOT, "scripts", "fixtures", "packs", p), path.join(copy, "packs", p), { recursive: true });
    const f = path.join(copy, "packs", p, "pack.json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    edit(p, j);
    writeFileSync(f, JSON.stringify(j, null, 2));
  }
  if (profile !== undefined) writeFileSync(path.join(copy, "profile.json"), JSON.stringify(profile, null, 2));
  const g = spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" });
  return { copy, status: g.status, out: `${g.stdout}\n${g.stderr}` };
}
const built = (...a: Parameters<typeof buildCopy>) => { const b = buildCopy(...a); assert.equal(b.status, 0, `gen-packs: ${b.out.slice(-1500)}`); return b.copy; };

const PROBE = `import { portalNav, adminNav } from '@/config/nav-config';
import { packTabs, hiddenConsoleUrls } from '@/config/pack-nav.generated';
import { PACK_GUIDE } from '@/config/pack-guides.generated';
process.stdout.write('\\u0001' + JSON.stringify({ portalNav, adminNav, packTabs, hiddenConsoleUrls, guide: PACK_GUIDE }));
`;
type Probe = { portalNav: any[]; adminNav: any[]; packTabs: any[]; hiddenConsoleUrls: string[]; guide: any };
function probe(copy: string): Probe {
  const web = path.join(copy, "web");
  const file = path.join(web, "probe-hide.tsx");
  writeFileSync(file, PROBE);
  try {
    const r = spawnSync(TSX, ["--tsconfig", path.join(web, "tsconfig.json"), file], { cwd: web, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `console probe: ${r.stderr.slice(0, 2000)}`);
    return JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1));
  } finally { rmSync(file, { force: true }); }
}
const urls = (groups: any[]) => groups.flatMap((g) => g.items.map((i: any) => i.url));
// Leaving out the nested addresses of before, which redirect to the flat ones (mold_v0-132; scripts/declarative-packs-test.ts).
const redirects = (copy: string) => JSON.parse(readFileSync(path.join(copy, "web", "src", "config", "pack-routes.generated.json"), "utf8")).redirects
  .filter((r: { source: string }) => !r.source.startsWith("/app/packs/"));
const GENERATED = ["web/src/config/pack-nav.generated.ts", "web/src/config/pack-routes.generated.json", "web/src/config/pack-guides.generated.ts", "src/packs.generated.ts"];
const read = (copy: string, f: string) => readFileSync(path.join(copy, f), "utf8");

try {
  // ---------- 1. nothing hidden ----------
  const plain = built("plain", ["fixture_vulns"]);
  const same = built("empty-hide", ["fixture_vulns"], (_id, j) => { j.console = { hide: [] }; });
  for (const f of GENERATED) assert.equal(read(same, f), read(plain, f), `${f}: an empty hide list changes nothing`);
  const p0 = probe(plain);
  assert.deepEqual(p0.hiddenConsoleUrls, []);
  assert.ok(urls(p0.portalNav).includes("/app/activity"), "fixture_vulns' usage tab opens the Activity page");
  assert.deepEqual(redirects(plain), []);
  console.log("✓ nothing hidden: the generated sidebar, tabs, guide and redirects are unchanged");

  // ---------- 2. a pack with tabs hides activity ----------
  {
    const copy = built("tabs-hide", ["fixture_vulns"], (_id, j) => { j.console = { hide: ["activity"] }; });
    const p = probe(copy);
    assert.deepEqual(p.hiddenConsoleUrls, ["/app/activity"]);
    assert.ok(!urls(p.portalNav).includes("/app/activity"), "the usage tab left the sidebar");
    assert.deepEqual(urls(p.portalNav), urls(p0.portalNav).filter((u) => u !== "/app/activity"), "and nothing else did");
    assert.ok(!p.packTabs.some((t) => t.kind === "usage"), "nor is it a tab page");
    assert.ok(!JSON.stringify(p.guide).includes('"kind":"usage"'), "the customer guide does not list it");
    assert.deepEqual(redirects(copy), [{ source: "/app/activity", destination: "/app", permanent: false }, { source: "/app/activity/:path*", destination: "/app", permanent: false }]);
    assert.deepEqual(urls(p.adminNav), urls(p0.adminNav), "the staff console is unchanged (its Activity page stays)");
    assert.ok(urls(p.adminNav).includes("/admin/activity"));
    console.log("✓ a pack with tabs hides activity: its usage tab leaves the sidebar, the tab pages and the guide; /app/activity redirects to /app; /admin is unchanged");
  }

  // ---------- 3. the shell's sidebar, a pack and the profile ----------
  {
    const base = built("shell-plain", ["fixture_tracker"]);
    const before = urls(probe(base).portalNav);
    assert.ok(["/app/activity", "/app/usage", "/app/billing", "/app/profile"].every((u) => before.includes(u)), `the shell's sidebar has them: ${before.join(" ")}`);
    const copy = built("shell-hide", ["fixture_tracker"], (_id, j) => { j.console = { hide: ["activity"] }; }, { console: { hide: ["usage", "billing"] } });
    const p = probe(copy);
    assert.deepEqual(p.hiddenConsoleUrls, ["/app/activity", "/app/usage", "/app/billing"], "the pack's and the profile's, joined");
    assert.deepEqual(urls(p.portalNav), before.filter((u) => !["/app/activity", "/app/usage", "/app/billing"].includes(u)), "exactly those left the sidebar");
    assert.ok(!p.portalNav.some((g) => g.label === "Activity" || !g.items.length), "no empty group is left");
    assert.deepEqual(redirects(copy).map((r: any) => r.source), ["/app/activity", "/app/activity/:path*", "/app/usage", "/app/usage/:path*", "/app/billing", "/app/billing/:path*"]);
    console.log("✓ the shell's sidebar: a pack hides activity, the profile usage and billing; exactly those leave it and redirect to /app");
  }

  // ---------- 4. refused ----------
  {
    const bad: [string, (id: string, j: any) => void, unknown, RegExp][] = [
      ["a page that is not one", (_i, j) => { j.console = { hide: ["setup"] }; }, undefined, /console\.hide/],
      ["a page twice", (_i, j) => { j.console = { hide: ["activity", "activity"] }; }, undefined, /each page once/],
      ["an unknown key", (_i, j) => { j.console = { show: ["activity"] }; }, undefined, /console/],
      ["the profile's unknown page", () => {}, { console: { hide: ["admin"] } }, /profile\.json console\.hide: "admin" is not a page/],
      ["the profile's unknown key", () => {}, { console: { nav: [] } }, /profile\.json console: unknown field nav/],
    ];
    let i = 0;
    for (const [what, edit, profile, re] of bad) {
      const b = buildCopy(`bad-${i++}`, ["fixture_tracker"], edit, profile);
      assert.notEqual(b.status, 0, `${what}: refused`);
      assert.match(b.out, re, what);
    }
    console.log(`✓ refused, each with its reason: ${bad.map((b) => b[0]).join("; ")}`);
  }
  console.log("CONSOLE HIDE TEST PASS");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
