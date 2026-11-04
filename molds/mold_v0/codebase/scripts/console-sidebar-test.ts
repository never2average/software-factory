// The whole /app sidebar from config (mold_v0-133; src/console-pages.ts, scripts/gen-packs.mjs), offline: build copies of
// the codebase with fixture packs and a profile, gen-packs run in each, the console's navigation read through tsx.
//   npm run test:console-sidebar
//
// 1. The profile declares the sidebar (profile.json console.sidebar): exactly its groups and entries, in its order, the
//    packs' tabs and the shell's pages (Team, API keys, Profile...) among them.
// 2. Zero packs: a profile sidebar of shell pages only; Connected apps (mold_v0-087) is an optional shell entry, in the
//    shell's own sidebar and wherever a declared sidebar lists it, never otherwise.
// 3. A pack's tabs reach the shell's Team and API keys pages (tab kinds team, keys); two tabs opening one shell page are
//    one entry (the first's).
// 4. Refused, each with its reason: a tab left out, an unknown entry, an entry twice, a shell page a tab already opens, a
//    page the build lacks (API keys with member keys off), two tabs opening one shell page, a sidebar in a pack.json, a
//    malformed sidebar.
// 5. The shell's own sidebar (no tabs, no declared sidebar): a pack's group named like a shell group joins it and a page
//    already in the sidebar is not listed again (mergeNav).
// 6. The active entry (mold_v0-213, web/src/lib/active-nav.ts): every console route of a build, both consoles, with
//    its in-page tabs (?tab=), a record's own page, a filtered view (?overdue=1), the home page with ?journey= and the
//    staff console's Accounts › Admins: exactly one entry lit, the right one; a page outside the sidebar (Docs) none.
// 7. Settings (mold_v0-218, web/src/config/nav-config.ts withSettings): one entry directly below Overview, a pack's
//    credentials tab or a declared sidebar's credentials moved there (its roles kept); none without Credentials or Email.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "console-sidebar-"));
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

const PROBE = `import { portalNav, mergeNav, withSettings } from '@/config/nav-config';
const home = { label: 'Get started', items: [{ title: 'Setup', url: '/app', items: [] }, { title: 'Usage', url: '/app/usage', items: [] }] };
const ops = { label: 'Operational', items: [{ title: 'Billing', url: '/app/billing', items: [] }] };
const own = { label: 'Company', items: [{ title: 'Credentials', url: '/app/settings', items: [], roles: ['member', 'owner'] }] };
const settings = {
  email: withSettings([home, ops], { credentials: false, email: true }),
  moved: withSettings([home, ops, own], { credentials: true, email: false }),
  none: withSettings([home, own, ops], { credentials: false, email: false }),
  noHome: withSettings([ops], { credentials: true, email: true }),
};
const merged = mergeNav([
  { label: 'Get started', items: [{ title: 'Setup', url: '/app', items: [] }] },
  { label: 'Operational', items: [{ title: 'Billing', url: '/app/billing', items: [] }] },
  { label: 'Get started', items: [{ title: 'Guide', url: '/app/guide', items: [] }, { title: 'Setup again', url: '/app', items: [] }] },
  { label: 'Extra', items: [{ title: 'Billing again', url: '/app/billing', items: [] }] },
]);
process.stdout.write('\\u0001' + JSON.stringify({ portalNav, merged, settings }));
`;
function probe(copy: string): { portalNav: any[]; merged: any[]; settings: Record<string, any[]> } {
  const web = path.join(copy, "web");
  const file = path.join(web, "probe-sidebar.tsx");
  writeFileSync(file, PROBE);
  try {
    const r = spawnSync(TSX, ["--tsconfig", path.join(web, "tsconfig.json"), file], { cwd: web, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `console probe: ${r.stderr.slice(0, 2000)}`);
    return JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1));
  } finally { rmSync(file, { force: true }); }
}
/** "Group: Title /url" per entry, in order. */
const lines = (groups: any[]) => groups.flatMap((g) => g.items.map((i: any) => `${g.label}: ${i.title} ${i.url}`));

const SIDEBAR = [
  { label: "Home", items: ["overview"] },
  { label: "Audit", items: ["audits", "vulnerabilities", "applications", "controls", "reports", "notices"] },
  { label: "Account", items: ["credentials", "activity", "billing", "team", "profile", "keys"] },
];

try {
  // ---------- 1. the profile declares the sidebar ----------
  {
    const p = probe(built("profile", ["fixture_vulns"], () => {}, { console: { sidebar: SIDEBAR } }));
    assert.deepEqual(lines(p.portalNav), [
      "Home: Overview /app/overview", "Home: Settings /app/settings",
      "Audit: Audits /app/audits", "Audit: Vulnerabilities /app/vulnerabilities", "Audit: Applications /app/applications", "Audit: Controls /app/controls",
      "Audit: Reports /app/reports", "Audit: Due soon /app/notices",
      "Account: Activity /app/activity", "Account: Billing /app/billing", "Account: Team /app/team",
      "Account: Profile /app/profile", "Account: API keys /app/keys",
    ], "exactly the declared groups and entries, in order: the pack's tabs by id, the shell's pages by kind; credentials is the one Settings entry, directly below Overview (mold_v0-218)");
    console.log("✓ the profile's sidebar: its groups and entries in its order, the pack's tabs and the shell's Team, Profile and API keys pages");
  }

  // ---------- 2. zero packs ----------
  {
    const p = probe(built("zero", [], () => {}, { console: { sidebar: [{ label: "", items: ["setup", "usage"] }, { label: "Account", items: ["billing", "team", "profile"] }] } }));
    assert.deepEqual(lines(p.portalNav), [": Setup /app", ": Activity /app/activity", "Account: Billing /app/billing", "Account: Team /app/team", "Account: Profile /app/profile"],
      "a shell with no pack: the shell's pages in the declared order");
    console.log("✓ zero packs: a declared sidebar of the shell's pages");
    // Connected apps (mold_v0-087): where the declared sidebar puts it; left out when it is not listed; refused when hidden.
    const c = probe(built("zero-connected", [], () => {}, { console: { sidebar: [{ label: "", items: ["setup"] }, { label: "You", items: ["profile", "connected-apps"] }] } }));
    assert.deepEqual(lines(c.portalNav), [": Setup /app", "You: Profile /app/profile", "You: Connected apps /app/connected-apps"], "listed: where the profile puts it");
    assert.ok(!lines(p.portalNav).some((x) => x.endsWith(" /app/connected-apps")), "a declared sidebar that does not list it has no entry for it");
    const shell = probe(built("zero-shell", []));
    assert.ok(lines(shell.portalNav).includes("Operational: Connected apps /app/connected-apps"), `the shell's own sidebar has it: ${lines(shell.portalNav).join(", ")}`);
    const hid = buildCopy("zero-connected-hidden", [], () => {}, { console: { hide: ["connected-apps"], sidebar: [{ label: "", items: ["setup", "connected-apps"] }] } });
    assert.notEqual(hid.status, 0, "a hidden page cannot be listed");
    assert.match(hid.out, /items\[1\] "connected-apps": the build hides that page \(console\.hide\)/);
    console.log("✓ connected apps: an optional shell entry, in the shell's own sidebar and where a declared sidebar lists it; a hidden one is refused");
  }

  // ---------- 3. team and keys tabs ----------
  {
    const p = probe(built("kinds", ["fixture_vulns"], (_id, j) => { j.tabs.push({ id: "people", kind: "team", group: "Workspace" }, { id: "my-keys", kind: "keys", group: "Workspace" }); }));
    const ws = lines(p.portalNav).filter((x) => x.startsWith("Workspace: "));
    assert.deepEqual(ws.slice(-2), ["Workspace: Team /app/team", "Workspace: API keys /app/keys"], `a pack's tabs open the Team and API keys pages: ${ws.join(", ")}`);
    console.log("✓ tab kinds team and keys: a pack's sidebar reaches the shell's Team and API keys pages");
    const twice = probe(built("twice", ["fixture_vulns"], (_id, j) => { j.tabs.push({ id: "plan", kind: "billing", label: "Plan", group: "More" }); }));
    assert.deepEqual(lines(twice.portalNav).filter((x) => x.endsWith(" /app/billing")), ["Workspace: Billing /app/billing"], "two tabs opening one page: one entry, the first's");
    assert.ok(!twice.portalNav.some((g) => g.label === "More"), "a group left with no entry is not drawn");
    console.log("✓ two tabs opening one shell page: one sidebar entry, the first tab's");
  }

  // ---------- 4. refused ----------
  {
    const without = (id: string) => SIDEBAR.map((g) => ({ ...g, items: g.items.filter((x) => x !== id) }));
    const bad: [string, (id: string, j: any) => void, unknown, RegExp][] = [
      ["a tab left out", () => {}, { console: { sidebar: without("reports") } }, /console\.sidebar: tab reports of pack fixture_vulns is not in it: the declared sidebar is the whole sidebar/],
      ["an unknown entry", () => {}, { console: { sidebar: [...SIDEBAR, { label: "More", items: ["nope"] }] } }, /items\[0\] "nope": no pack has a tab nope, and it is not a shell page/],
      ["an entry twice", () => {}, { console: { sidebar: [...SIDEBAR, { label: "More", items: ["overview"] }] } }, /items\[0\] "overview": listed twice/],
      ["a shell page a tab opens", () => {}, { console: { sidebar: [...SIDEBAR, { label: "More", items: ["usage"] }] } }, /"usage": tab activity of pack fixture_vulns opens that page: list the tab \(fixture_vulns\/activity\)/],
      ["API keys with member keys off", () => {}, { member_keys: false, console: { sidebar: SIDEBAR } }, /"keys": member API keys are off \(profile\.json member_keys\), so there is no API keys page to list/],
      ["a keys tab with member keys off", (_id, j) => { j.tabs.push({ id: "my-keys", kind: "keys" }); }, { member_keys: false }, /tab my-keys: member API keys are off/],
      ["a sidebar in a pack.json", (_id, j) => { j.console = { sidebar: SIDEBAR }; }, undefined, /pack\.json console: sidebar is the app's \(profile\.json\)/],
      ["a malformed sidebar", () => {}, { console: { sidebar: [] } }, /console\.sidebar: a list of 1 to 12 groups/],
      ["a malformed entry", () => {}, { console: { sidebar: [{ label: "A", items: ["Bad Entry"] }] } }, /console\.sidebar\[0\]\.items\[0\]: a tab id/],
    ];
    let i = 0;
    for (const [what, edit, profile, re] of bad) {
      const b = buildCopy(`bad-${i++}`, ["fixture_vulns"], edit, profile);
      assert.notEqual(b.status, 0, `${what}: refused (${b.out.slice(-500)})`);
      assert.match(b.out, re, what);
    }
    console.log(`✓ refused, each with its reason: ${bad.map((b) => b[0]).join("; ")}`);
  }

  // ---------- 5. the shell's own sidebar never repeats a group or a page ----------
  {
    const p = probe(built("shell", ["fixture_tracker"]));
    assert.deepEqual(lines(p.merged), ["Get started: Setup /app", "Get started: Guide /app/guide", "Operational: Billing /app/billing"],
      "a group named like an earlier one joins it; a page already listed is left out; a group left empty goes");
    const labels = p.portalNav.map((g) => g.label), urls = lines(p.portalNav).map((x) => x.split(" ").at(-1));
    assert.equal(new Set(labels).size, labels.length, `one group per heading: ${labels.join(", ")}`);
    assert.equal(new Set(urls).size, urls.length, `one entry per page: ${urls.join(", ")}`);
    console.log("✓ the shell's own sidebar: one group per heading, one entry per page");
  }
  // ---------- 7. one Settings entry, directly below Overview (mold_v0-218) ----------
  {
    const shell = probe(built("zero-settings", []));
    const s = shell.settings;
    assert.deepEqual(lines(s.email), ["Get started: Setup /app", "Get started: Settings /app/settings", "Get started: Usage /app/usage", "Operational: Billing /app/billing"], "Email alone: Settings directly below the home page");
    assert.deepEqual(lines(s.moved), ["Get started: Setup /app", "Get started: Settings /app/settings", "Get started: Usage /app/usage", "Operational: Billing /app/billing"], "a credentials entry elsewhere moves below Overview, its group left out when empty");
    assert.deepEqual(s.moved[0].items[1].roles, ["member", "owner"], "its roles kept");
    assert.deepEqual(lines(s.none), ["Get started: Setup /app", "Get started: Usage /app/usage", "Operational: Billing /app/billing"], "neither Credentials nor Email: no Settings entry");
    assert.deepEqual(lines(s.noHome), ["Operational: Settings /app/settings", "Operational: Billing /app/billing"], "no Overview: first");
    assert.ok(!lines(shell.portalNav).some((x) => /\/app\/(settings|credentials)/.test(x)), `zero packs: no Settings entry: ${lines(shell.portalNav).join(", ")}`);
    console.log("✓ Settings (mold_v0-218): one entry directly below Overview (the home page or the first overview tab), a credentials entry moved there with its roles; none without Credentials or Email");
  }

  // ---------- 6. exactly one active entry on every page (mold_v0-213) ----------
  {
    // A Maxwell-like build: in-page tabs (a sections tab), a filtered tab of an area listed elsewhere, a page that moved
    // into another's tabs; and the shell's own sidebar with zero packs.
    const copy = built("active", ["fixture_vulns"], (_id, j) => {
      j.tabs.push({ id: "fixes", kind: "area", area: "audit_findings", label: "Fixes", filter: { state: { in: ["fixed", "accepted"] } } },
        { id: "workbench", kind: "sections", label: "Workbench", group: "Audit", sections: ["applications", "fixes"] });
    });
    const zero = built("active-zero", []);
    const ACTIVE_PROBE = `import { adminNav, portalNav } from '@/config/nav-config';
import { packTabs } from '@/config/pack-nav.generated';
import routes from '@/config/console-routes.generated.json';
import packRoutes from '@/config/pack-routes.generated.json';
import { activeNavUrl, navOptions, navUrls } from '@/lib/active-nav';
import { readFileSync } from 'node:fs';
const redirected = (p: string) => packRoutes.redirects.some((r) => r.source === p || (r.source.endsWith('/:path*') && p.startsWith(r.source.slice(0, -7))));
// A page that only redirects is never drawn (its own page.tsx: redirect() and nothing to draw).
const redirectOnly = (route: string) => { const f = readFileSync('src/app' + route + '/page.tsx', 'utf8'); return /\\bredirect\\(/.test(f) && !/return\\s*\\(?\\s*</.test(f); };
const pages: string[] = [];
for (const r of routes.routes as string[]) {
  if (!/^\\/(app|admin)(\\/|$)/.test(r) || /\\[\\.\\.\\.missing\\]|\\/host\\//.test(r) || redirectOnly(r)) continue;
  if (r === '/app/[page]') { pages.push(...packTabs.map((t) => t.url).filter((u) => u.startsWith('/app/'))); continue; }
  if (r.includes('/records/[area]')) {
    const areas = r.startsWith('/app') ? [...new Set(packTabs.flatMap((t) => (t.areas ?? []).map((a) => a.area).concat(t.area ?? [])))] : adminNav.flatMap((g) => g.items).map((i) => /^\\/admin\\/records\\/([^/?]+)$/.exec(i.url)?.[1]).filter((x): x is string => !!x);
    for (const a of areas) pages.push(r.replace('[area]', a).replace('[key]', 'k-1'));
    continue;
  }
  if (r === '/admin/packs/[pack]/[page]') { pages.push(...adminNav.flatMap((g) => g.items).map((i) => i.url).filter((u) => u.startsWith('/admin/packs/'))); continue; }
  pages.push(r.replace('[slug]', 'acme').replace('/[[...section]]', ''));
}
pages.push('/app?journey=first-audit', '/app/vulnerabilities?overdue=1', '/admin/accounts?section=admins', '/admin/accounts/acme?section=team');
const walk = (area: 'portal' | 'admin', groups: typeof portalNav) => {
  const base = area === 'admin' ? '/admin' : '/app';
  // As the sidebar draws them: the footer's API keys and Profile are lit only when the groups have no entry of their own.
  const own = navUrls(groups, []);
  const urls = navUrls(groups, [...(area === 'portal' ? ['/app/keys'] : []), base + '/profile'].filter((u) => !own.includes(u)));
  return Object.fromEntries(pages.filter((p) => p === base || p.startsWith(base + '/') || p.startsWith(base + '?')).filter((p) => !redirected(p.split('?')[0]!))
    .map((p) => [p, { lit: urls.filter((u) => u === activeNavUrl(p, urls, navOptions(area))), urls }]));
};
process.stdout.write('\\u0001' + JSON.stringify({ portal: walk('portal', portalNav), admin: walk('admin', adminNav) }));
`;
    const walk = (c: string) => {
      const web = path.join(c, "web"), file = path.join(web, "probe-active.tsx");
      writeFileSync(file, ACTIVE_PROBE);
      try {
        const r = spawnSync(TSX, ["--tsconfig", path.join(web, "tsconfig.json"), file], { cwd: web, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        assert.equal(r.status, 0, `active probe: ${r.stderr.slice(0, 2000)}`);
        return JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1)) as Record<"portal" | "admin", Record<string, { lit: string[]; urls: string[] }>>;
      } finally { rmSync(file, { force: true }); }
    };
    // Outside every sidebar: the guide (the header's Docs button opens it), and pages a build without the feature lacks.
    const OUTSIDE = /^\/(app|admin)\/docs(\/|$)/;
    let n = 0;
    const expect = (name: string, got: ReturnType<typeof walk>, want: Record<string, string>, absent: RegExp = /^$/) => {
      const bad: string[] = [];
      for (const area of ["portal", "admin"] as const) for (const [page, { lit, urls }] of Object.entries(got[area])) {
        n++;
        if (OUTSIDE.test(page) || (absent.test(page) && !lit.length)) { if (lit.length) bad.push(`${page} is outside the sidebar, yet lights [${lit.join(", ")}]`); continue; }
        if (lit.length !== 1) bad.push(`${page}: exactly one entry lit, got [${lit.join(", ")}] of ${urls.join(" ")}`);
        else if (want[page] && lit[0] !== want[page]) bad.push(`${page} lights ${lit[0]}, not ${want[page]}`);
      }
      assert.deepEqual(bad, [], `${name}: every page lights exactly its one entry`);
      for (const page of Object.keys(want)) assert.ok(page in got.portal || page in got.admin, `${name}: ${page} was walked`);
    };
    // Pages a build has only with a feature it lacks here (a mailbox, the developer surface, a workspace store, the
    // account context, a data repository, an audit trail): each is not found in such a build; with the feature it has its own entry.
    const ABSENT = /^\/app\/(settings|developers|files|context)$|^\/admin\/(repositories|access-log)$/;
    expect("tabs", walk(copy), {
      "/app": "/app/overview", "/app?journey=first-audit": "/app/overview", "/app/journeys": "/app/overview",
      "/app/workbench?tab=fixes": "/app/workbench", "/app/workbench?tab=applications": "/app/workbench",
      "/app/records/audit_findings/k-1": "/app/vulnerabilities", "/app/records/audit_apps/k-1": "/app/workbench",
      "/app/vulnerabilities?overdue=1": "/app/vulnerabilities", "/app/billing": "/app/billing", "/app/profile": "/app/profile",
      "/app/connected-apps": "/app/profile",
      "/admin": "/admin", "/admin/accounts?section=admins": "/admin/accounts", "/admin/accounts/acme": "/admin/accounts",
      "/admin/accounts/acme?section=team": "/admin/accounts", "/admin/records/audit_controls/k-1": "/admin/records/audit_controls",
    }, ABSENT);
    // With zero packs the pages a pack brings (Activity, Credentials, Notices, Schedules, a pack's tab) are not found.
    // (The staff's /admin/activity is no route at all since mold_v0-211: not walked.)
    expect("zero packs", walk(zero), { "/app": "/app", "/app/billing": "/app/billing", "/app/usage": "/app/usage", "/app/profile": "/app/profile", "/admin/health": "/admin/health" },
      new RegExp(`${ABSENT.source}|^/app/(activity|credentials|notices|schedules|vulnerabilities)(\\?|$)`));
    console.log(`✓ the active entry (mold_v0-213): ${n} pages of both consoles each light exactly one entry, the right one (in-page tabs, a record's page, a filter, ?journey=, Accounts › Admins); Docs none`);
  }
  console.log("CONSOLE SIDEBAR TEST PASS");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
