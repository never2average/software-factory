// The developer surface's console (mold_v0-201; web/src/features/developer, /app/developers), offline and without a
// browser: build copies of the codebase with fixture packs, gen-packs run in each, the console's navigation and route
// table read through tsx.
//   npm run test:developer-console
//
// 1. An embedded app (fixture_embedded: a pack declares developer_surface, with webhooks_in): Settings › Developers in
//    the sidebar, the page's route shown, the Inbound tab on; the shell's own pages unchanged around it.
// 2. A tool app (a pack without developer_surface) and zero packs: no entry, no page (the route not shown), and the rest
//    of the sidebar exactly as before (the same as a build of the same packs without this console's lines).
// 3. The page's plain helpers: its tabs (Inbound only with webhooks in), a delivery's payload as the log shows it (a
//    credential-named field or a key or secret value masked), deliveries per day for the log's sparkline.
// 4. The page's shape: every list is the console's database table (RecordView), every change an owner's (Allowed need
//    'manage' or lock(..., 'manage')), a secret only in the shown-once dialog, nothing linking to a staff page.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "developer-console-"));
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const ok = (m: string) => console.log(`✓ ${m}`);

/** A build copy with these fixture packs; gen-packs run. */
function built(name: string, packs: string[]) {
  const copy = path.join(TMP, name);
  const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
  cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
  for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
  mkdirSync(path.join(copy, "packs"), { recursive: true });
  cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
  for (const p of packs) cpSync(path.join(ROOT, "scripts", "fixtures", "packs", p), path.join(copy, "packs", p), { recursive: true });
  const g = spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" });
  assert.equal(g.status, 0, `gen-packs (${name}): ${`${g.stdout}\n${g.stderr}`.slice(-1500)}`);
  return copy;
}

const PROBE = `import { portalNav } from '@/config/nav-config';
import { developerConsole, developerPortalNav } from '@/config/pack-nav.generated';
import routes from '@/config/console-routes.generated.json';
import { SHOWN } from '@/lib/console-routes';
process.stdout.write('\\u0001' + JSON.stringify({ portalNav, developerConsole, developerPortalNav, routes, shown: SHOWN['/app/developers']?.() ?? null }));
`;
function probe(copy: string): { portalNav: any[]; developerConsole: { on: boolean; inbound: boolean }; developerPortalNav: any[]; routes: any; shown: boolean | null } {
  const web = path.join(copy, "web");
  const file = path.join(web, "probe-developer.tsx");
  writeFileSync(file, PROBE);
  try {
    const r = spawnSync(TSX, ["--tsconfig", path.join(web, "tsconfig.json"), file], { cwd: web, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `console probe: ${r.stderr.slice(0, 2000)}`);
    return JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1));
  } finally { rmSync(file, { force: true }); }
}
const lines = (groups: any[]) => groups.flatMap((g) => g.items.map((i: any) => `${g.label}: ${i.title} ${i.url}`));
const routeList = (r: any): string[] => (Array.isArray(r) ? r : Object.values(r).flat()) as string[];

try {
  // ---------- 1. an embedded app ----------
  const emb = probe(built("embedded", ["fixture_embedded"]));
  assert.deepEqual(emb.developerConsole, { on: true, inbound: true }, "the console is on, with its Inbound tab (the fixture declares webhooks_in)");
  assert.ok(lines(emb.portalNav).includes("Settings: Developers /app/developers"), `Settings › Developers in the sidebar: ${lines(emb.portalNav).join(", ")}`);
  assert.equal(lines(emb.portalNav).filter((x) => x.endsWith(" /app/developers")).length, 1, "one entry");
  assert.equal(emb.shown, true, "the page's route is shown");
  assert.ok(routeList(emb.routes).includes("/app/developers"), "the route is in the console's route table");
  ok("an embedded app: Settings › Developers in the sidebar, its page shown, the Inbound tab on");

  // ---------- 2. a tool app, zero packs ----------
  for (const [name, packs] of [["tool", ["fixture_vulns"]], ["zero", []]] as const) {
    const p = probe(built(name, [...packs]));
    assert.deepEqual(p.developerConsole, { on: false, inbound: false }, `${name}: off`);
    assert.deepEqual(p.developerPortalNav, [], `${name}: no Developers group`);
    assert.ok(!lines(p.portalNav).some((x) => x.includes("/app/developers")), `${name}: no entry`);
    assert.equal(p.shown, false, `${name}: the page is not found`);
    assert.ok(!p.portalNav.some((g: any) => g.label === "Settings"), `${name}: no Settings group of its own (no email, no developer surface)`);
  }
  ok("a tool app and zero packs: no Developers entry, the page not found, no Settings group added");

  // ---------- 3. the plain helpers ----------
  const w = await import(pathToFileURL(path.join(ROOT, "web", "src", "features", "developer", "words.ts")).href);
  assert.deepEqual(w.developerTabs(true).map((t: any) => t.id), ["keys", "webhooks", "origins", "inbound"]);
  assert.deepEqual(w.developerTabs(false).map((t: any) => t.id), ["keys", "webhooks", "origins"], "no Inbound tab without webhooks in");
  const shown = w.redacted({ type: "record.created", data: { key: "T-1", fields: { summary: "s", api_key: "x", nested: [{ client_secret: "y", note: "sk_live_abcdef123", ok: "whsec_ZZZ" }] } }, authorization: "Bearer z" });
  const text = JSON.stringify(shown);
  for (const leak of ["\"x\"", "\"y\"", "sk_live_abcdef123", "whsec_ZZZ", "Bearer z"]) assert.ok(!text.includes(leak), `masked: ${leak} (${text})`);
  assert.equal((shown as any).data.key, "T-1", "a record's key is not a credential: kept");
  assert.equal((shown as any).data.fields.summary, "s");
  const now = Date.UTC(2026, 10, 2, 12);
  assert.deepEqual(w.perDay([new Date(now).toISOString(), new Date(now - 3_600_000).toISOString(), new Date(now - 86_400_000).toISOString(), new Date(now - 30 * 86_400_000).toISOString()], 3, now), [0, 1, 2],
    "per day, oldest first; older than the window left out");
  ok("helpers: tabs (Inbound only with webhooks in), payloads masked (credential names and key or secret values), deliveries per day");

  // ---------- 4. the page's shape ----------
  const dir = path.join(ROOT, "web", "src", "features", "developer");
  const src = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".tsx")).map((f) => [f, readFileSync(path.join(dir, f), "utf8")]));
  for (const f of ["keys.tsx", "webhooks.tsx", "origins.tsx", "inbound.tsx"]) {
    assert.match(src[f]!, /<RecordView</, `${f}: the console's database table`);
    assert.match(src[f]!, /<Allowed need='manage'>/, `${f}: its changes need the owner's manage`);
    // Every row menu action (each changes something) is locked to manage.
    const actions = (src[f]!.match(/onSelect:/g) ?? []).length, locked = (src[f]!.match(/lock\(\{ label:/g) ?? []).length;
    assert.equal(actions, locked, `${f}: ${actions - locked} row action(s) not locked to manage`);
    assert.doesNotMatch(src[f]!, /\/admin\//, `${f}: no staff page`);
  }
  for (const f of ["keys.tsx", "webhooks.tsx", "inbound.tsx"]) assert.match(src[f]!, /<OnceDialog /, `${f}: a secret is shown once, in the dialog`);
  assert.doesNotMatch(src["keys.tsx"]!, /key_hash|\.key\b(?!_prefix)[^(]*<\/code>/, "a key is never drawn from the list");
  assert.match(src["webhooks.tsx"]!, /redacted\(d\.payload\)/, "the payload preview is masked");
  assert.match(src["webhooks.tsx"]!, /<StatStrip quad/, "the delivery log's numbers and sparklines");
  assert.match(src["developer-page.tsx"]!, /<PageContainer>/, "a page of in-page tabs starts with its tab strip: no title above it (mold_v0-180)");
  ok("the page: database tables, an owner's changes, secrets only once, a masked payload preview, the log's sparklines, no title above the tabs");

  console.log("DEVELOPER CONSOLE TEST PASS");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
