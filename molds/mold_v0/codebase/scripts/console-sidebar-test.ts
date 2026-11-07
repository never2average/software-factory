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
// 8. Each record area's icon (mold_v0-242, src/record-icons.ts): no two Records entries in a sidebar share one, both
//    declared and picked (none repeats another staff entry's); an area's icon is the same in the staff sidebar, the
//    customer sidebar and its spec; its own icon, else its customer tab's, else a fallback from its name; two areas
//    declaring one icon is a build warning; an icon outside the set is refused.
// 9. The staff Records group from config (mold_v0-271, console.admin_records in a pack.json or profile.json): exactly
//    its entries in its order (shared areas by name, relabelled where it says, and the shell's staff pages by id);
//    Journeys placed there leaves its Engagement group, at the same address, lit there; a shared area left out is not in
//    the staff sidebar but keeps its spec (its page, list and record), its customer Records entry, and lights nothing
//    (no wrong entry) when opened by link; the profile's wins over a pack's; the Recipes page with the workspace agent
//    on asks for workspace_recipes; refused: an unknown name, a workspace area, a page the build lacks (Recipes without
//    the workspace agent), an entry twice, two packs declaring it.
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
let MANY = "";
const built = (...a: Parameters<typeof buildCopy>) => { const b = buildCopy(...a); assert.equal(b.status, 0, `gen-packs: ${b.out.slice(-1500)}`); return b.copy; };

const PROBE = `import { portalNav, mergeNav, withSettings } from '@/config/nav-config';
import { settingsLayout, settingsTabUrl, pageTabs } from '@/config/settings';
import { settingsTabs } from '@/config/pack-nav.generated';
const T = (id: string, group: 'access' | 'connections' | 'automation' | 'data_trust') => ({ id, label: id, group, kind: 'area' as const });
const FIVE = [T('credentials', 'access'), T('api_keys', 'access'), T('email', 'connections'), T('webhooks', 'connections'), T('alerts', 'automation')];
const SEVEN = [...FIVE.slice(0, 2), T('allowed_origins', 'access'), ...FIVE.slice(2), T('signing', 'data_trust')];
const home = { label: 'Get started', items: [{ title: 'Setup', url: '/app', items: [] }, { title: 'Usage', url: '/app/usage', items: [] }] };
const ops = { label: 'Operational', items: [{ title: 'Billing', url: '/app/billing', items: [] }] };
const own = { label: 'Company', items: [{ title: 'Credentials', url: '/app/settings', items: [], roles: ['member', 'owner'] }] };
const settings = {
  email: withSettings([home, ops], [T('email', 'connections')]),
  moved: withSettings([home, ops, own], [T('credentials', 'access')]),
  none: withSettings([home, own, ops], []),
  noHome: withSettings([ops], FIVE.slice(0, 2)),
  five: withSettings([home, ops], FIVE),
  seven: withSettings([home, ops], SEVEN),
};
const layout = {
  counts: [[], FIVE.slice(0, 1), FIVE.slice(0, 2), FIVE, SEVEN].map((t) => settingsLayout(t)),
  fiveUrls: FIVE.map((t) => settingsTabUrl(t.id, FIVE)),
  sevenUrls: SEVEN.map((t) => settingsTabUrl(t.id, SEVEN)),
  sevenPages: ['access', 'connections', 'automation', 'data-trust', 'nope'].map((g) => pageTabs(g, SEVEN).map((t) => t.id)),
  built: settingsTabs.map((t) => \`\${t.group}:\${t.id}\`), builtLayout: settingsLayout(),
};
const merged = mergeNav([
  { label: 'Get started', items: [{ title: 'Setup', url: '/app', items: [] }] },
  { label: 'Operational', items: [{ title: 'Billing', url: '/app/billing', items: [] }] },
  { label: 'Get started', items: [{ title: 'Guide', url: '/app/guide', items: [] }, { title: 'Setup again', url: '/app', items: [] }] },
  { label: 'Extra', items: [{ title: 'Billing again', url: '/app/billing', items: [] }] },
]);
process.stdout.write('\\u0001' + JSON.stringify({ portalNav, merged, settings, layout }));
`;
function probe(copy: string): { portalNav: any[]; merged: any[]; settings: Record<string, any[]>; layout: any } {
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
    assert.deepEqual(shell.layout.counts, ["none", "single", "strip", "strip", "groups"], "0 tabs none, 1 one table, 2 to 5 one strip, past 5 a page per group (mold_v0-219)");
    assert.deepEqual(lines(s.email), ["Get started: Setup /app", "Get started: Settings /app/settings", "Get started: Usage /app/usage", "Operational: Billing /app/billing"], "1 tab (Email alone): Settings directly below the home page, opening that table");
    assert.deepEqual(lines(s.moved), ["Get started: Setup /app", "Get started: Settings /app/settings", "Get started: Usage /app/usage", "Operational: Billing /app/billing"], "a credentials entry elsewhere moves below Overview, its group left out when empty");
    assert.deepEqual(s.moved[0].items[1].roles, ["member", "owner"], "its roles kept");
    assert.deepEqual(lines(s.none), ["Get started: Setup /app", "Get started: Usage /app/usage", "Operational: Billing /app/billing"], "neither Credentials nor Email: no Settings entry");
    assert.deepEqual(lines(s.noHome), ["Operational: Settings /app/settings", "Operational: Billing /app/billing"], "no Overview: first");
    assert.deepEqual(lines(s.five), ["Get started: Setup /app", "Get started: Settings /app/settings", "Get started: Usage /app/usage", "Operational: Billing /app/billing"], "5 tabs: still one entry");
    assert.deepEqual(s.five[0].items[1].items, [], "5 tabs: no sub-entries");
    assert.deepEqual(shell.layout.fiveUrls, ["/app/settings", "/app/settings?tab=api_keys", "/app/settings?tab=email", "/app/settings?tab=webhooks", "/app/settings?tab=alerts"], "up to 5: ?tab= on /app/settings, the first bare");
    assert.deepEqual(lines(s.seven), ["Get started: Setup /app", "Get started: Settings /app/settings", "Get started: Usage /app/usage", "Operational: Billing /app/billing"], "past 5: Settings below Overview (/app/settings leads to its first group)");
    assert.deepEqual(s.seven[0].items[1].items.map((i: any) => `${i.title} ${i.url}`), ["Access /app/settings/access", "Connections /app/settings/connections", "Automation /app/settings/automation", "Data & trust /app/settings/data-trust"],
      "past 5: a collapsible Settings entry, one item per group that has a tab, in the fixed order");
    assert.deepEqual(shell.layout.sevenUrls, ["/app/settings/access", "/app/settings/access?tab=api_keys", "/app/settings/access?tab=allowed_origins", "/app/settings/connections",
      "/app/settings/connections?tab=webhooks", "/app/settings/automation", "/app/settings/data-trust"], "past 5: each tab on its group's page, the group's first bare");
    assert.deepEqual(shell.layout.sevenPages, [["credentials", "api_keys", "allowed_origins"], ["email", "webhooks"], ["alerts"], ["signing"], []], "each group page shows its own tabs; an unknown group none");
    assert.deepEqual([shell.layout.built, shell.layout.builtLayout], [[], "none"], "zero packs: no Settings tab");
    assert.ok(!lines(shell.portalNav).some((x) => /\/app\/(settings|credentials)/.test(x)), `zero packs: no Settings entry: ${lines(shell.portalNav).join(", ")}`);
    console.log("✓ Settings (mold_v0-218, mold_v0-219): 0 tabs no entry, 1 one table, 2 to 5 one entry with a strip, past 5 a collapsible entry per group (Access, Connections, Automation, Data & trust); directly below Overview, a credentials entry moved there with its roles");
    // A build whose capabilities give more than 5 tabs (the developer surface's four, Credentials, Email, Alerts, Signing)
    // and a pack area declared as settings: the generated tabs in group order, and the grouped sidebar.
    const many = probe(built("settings-many", ["fixture_embedded"], (_id, j) => {
      j.credentials = [{ name: "api_token", label: "API token", bound_to: "workspace", deliver_as: { env: "API_TOKEN" } }];
      j.email = { sender: { allow: true } };
      j.record_areas.push({ name: "escalation_contacts", label: "Escalation contacts", role: "source", scope: "workspace", settings: { group: "automation", label: "Escalation contacts" },
        fields: [{ name: "person", label: "Person", type: "text", required: true }] });
    }, { features: { "audit.data": true, "audit.sign": true } }));
    assert.deepEqual(many.layout.built, ["access:credentials", "access:api_keys", "access:allowed_origins", "connections:email", "connections:webhooks", "connections:integrations",
      "automation:alerts", "automation:escalation_contacts", "data_trust:signing"], "each capability's tabs and the pack's settings area, in group order");
    assert.equal(many.layout.builtLayout, "groups");
    const entry = many.portalNav.flatMap((g: any) => g.items).find((i: any) => i.title === "Settings");
    assert.deepEqual(entry.items.map((i: any) => i.title), ["Access", "Connections", "Automation", "Data & trust"], "the grouped sidebar entry");
    assert.ok(!lines(many.portalNav).some((x) => /escalation_contacts|\/app\/developers/.test(x)), "the settings area is not in Records, and there is no Developers page");
    MANY = built("settings-many-active", ["fixture_embedded"], (_id, j) => { j.credentials = [{ name: "api_token", label: "API token", bound_to: "workspace", deliver_as: { env: "API_TOKEN" } }]; j.email = { sender: { allow: true } }; }, { features: { "audit.data": true, "audit.sign": true } });
    console.log("✓ a build with 9 Settings tabs (fixture_embedded + credentials, email, alerts, signing, a pack's settings area): grouped, one sidebar item per group");
  }

  // ---------- 6. exactly one active entry on every page (mold_v0-213) ----------
  {
    // An audit-app-like build: in-page tabs (a sections tab), a filtered tab of an area listed elsewhere, a page that moved
    // into another's tabs; and the shell's own sidebar with zero packs.
    const copy = built("active", ["fixture_vulns"], (_id, j) => {
      j.tabs.push({ id: "fixes", kind: "area", area: "audit_findings", label: "Fixes", filter: { state: { in: ["fixed", "accepted"] } } },
        { id: "workbench", kind: "sections", label: "Workbench", group: "Audit", sections: ["applications", "fixes"] });
    });
    const zero = built("active-zero", []);
    const ACTIVE_PROBE = `import { adminNav, portalNav } from '@/config/nav-config';
import { packTabs } from '@/config/pack-nav.generated';
import { settingsGroups, settingsLayout } from '@/config/settings';
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
  if (r === '/app/settings/[group]') { if (settingsLayout() === 'groups') pages.push(...settingsGroups().flatMap((g) => [g.url, ...g.tabs.slice(1).map((t) => \`\${g.url}?tab=\${t.id}\`)])); continue; }
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
    // mold_v0-271: Recipes (and a recipe's page) is a page only with workspace_recipes on.
    const ABSENT = /^\/app\/(settings|settings\/\[group\]|files|context)$|^\/admin\/(repositories|access-log|recipes|recipes\/\[id\])$/;
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
    // Past 5 Settings tabs (mold_v0-219): each group's page, and each of its tabs, lights that group's item.
    expect("settings groups", walk(MANY), {
      "/app/settings/access": "/app/settings/access", "/app/settings/access?tab=api_keys": "/app/settings/access",
      "/app/settings/connections?tab=webhooks": "/app/settings/connections", "/app/settings/automation": "/app/settings/automation",
      "/app/settings/data-trust": "/app/settings/data-trust",
    }, /^\/app\/(files|context|schedules|vulnerabilities)(\?|$)|^\/admin\/(repositories|access-log|recipes|recipes\/\[id\])$/); // pages this fixture lacks; the staff access log has no sidebar entry (as on main)
    // How it is lit (mold_v0-216): the brand's tint behind it and its words in the brand's colour, light and dark, the
    // phone's sheet the same component; no bar at its edge.
    const side = readFileSync(path.join(ROOT, "web", "src", "components", "layout", "app-sidebar.tsx"), "utf8");
    const lit = /const ACTIVE = '([^']+)'/.exec(side)?.[1] ?? "";
    for (const c of ["data-active:bg-primary/10", "dark:data-active:bg-primary/20", "data-active:text-primary"]) assert.ok(lit.split(" ").includes(c), `the active entry keeps ${c}: ${lit}`);
    assert.doesNotMatch(lit, /shadow|inset|border-l|before:/, "no bar at the active entry's edge (mold_v0-216)");
    console.log(`✓ the active entry (mold_v0-213): ${n} pages of both consoles each light exactly one entry, the right one (in-page tabs, a record's page, a filter, ?journey=, Accounts › Admins); Docs none`);
  }

  // ---------- 8. each record area's own icon (mold_v0-242) ----------
  {
    const { RECORD_FALLBACK_ICONS, recordAreaIcons, recordIconDuplicates } = await import("../src/record-icons.js");
    const { TAB_ICONS } = await import("../src/pack-api.js");
    const ICON_PROBE = `import { adminNav, portalNav } from '@/config/nav-config';
import { recordAreas } from '@/config/pack-nav.generated';
import { Icons } from '@/components/icons';
process.stdout.write('\\u0001' + JSON.stringify({ adminNav, portalNav, areas: recordAreas.map((a) => ({ name: a.name, scope: a.scope, icon: a.icon })), icons: Object.keys(Icons) }));
`;
    type Probe = { adminNav: any[]; portalNav: any[]; areas: { name: string; scope: string; icon: string }[]; icons: string[] };
    const iconProbe = (c: string): Probe => {
      const web = path.join(c, "web"), file = path.join(web, "probe-icons.tsx");
      writeFileSync(file, ICON_PROBE);
      try {
        const r = spawnSync(TSX, ["--tsconfig", path.join(web, "tsconfig.json"), file], { cwd: web, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        assert.equal(r.status, 0, `icon probe: ${r.stderr.slice(0, 2000)}`);
        return JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1));
      } finally { rmSync(file, { force: true }); }
    };
    const records = (groups: any[], base: string) => groups.flatMap((g) => g.items).filter((i: any) => i.url.startsWith(`/${base}/records/`));
    const others = (groups: any[], base: string) => groups.flatMap((g) => g.items).filter((i: any) => !i.url.startsWith(`/${base}/records/`));
    /** Every Records entry has an icon of the set, none twice; each area's the same in both sidebars and its spec. */
    const holds = (name: string, p: Probe, opts: { staffClash?: boolean } = {}) => {
      const staff = records(p.adminNav, "admin"), portal = records(p.portalNav, "app");
      for (const [where, list] of [["staff", staff], ["customer", portal]] as const) {
        for (const i of list) assert.ok(i.icon && (TAB_ICONS as readonly string[]).includes(i.icon) && p.icons.includes(i.icon), `${name}: ${where} entry ${i.url} has an icon of the set (${i.icon})`);
        const icons = list.map((i: any) => i.icon);
        assert.equal(new Set(icons).size, icons.length, `${name}: no two ${where} Records entries share an icon: ${list.map((i: any) => `${i.url}=${i.icon}`).join(", ")}`);
      }
      const spec = Object.fromEntries(p.areas.map((a) => [a.name, a.icon]));
      for (const i of staff) assert.equal(i.icon, spec[i.url.split("/").pop()], `${name}: ${i.url} shows its spec's icon`);
      for (const i of portal) assert.equal(i.icon, spec[i.url.split("/").pop()], `${name}: ${i.url} shows its spec's icon`);
      if (!opts.staffClash) {
        const rest = new Set(others(p.adminNav, "admin").map((i: any) => i.icon));
        for (const i of staff) assert.ok(!rest.has(i.icon), `${name}: staff entry ${i.url}'s icon ${i.icon} is no other staff entry's (${[...rest].join(", ")})`);
      }
      return { staff, portal, spec };
    };
    assert.ok(RECORD_FALLBACK_ICONS.every((x) => (TAB_ICONS as readonly string[]).includes(x)), "the fallback list is tab icons only");
    assert.equal(new Set(RECORD_FALLBACK_ICONS).size, RECORD_FALLBACK_ICONS.length, "the fallback list names each icon once");

    // a. Fallback: four packs with no tabs and no declared icon (5 shared areas, 13 of the workspace's own).
    const many = ["fixture_catalog", "fixture_checks", "fixture_review", "fixture_tracker"];
    const fb = iconProbe(built("icons-fallback", many));
    const f = holds("fallback", fb);
    assert.equal(f.staff.length, 5, `five shared areas in the staff sidebar: ${f.staff.map((i: any) => i.url).join(", ")}`);
    assert.ok(f.portal.length >= 15, `every area in the customer sidebar's Records group: ${f.portal.length}`);
    assert.ok(Object.values(f.spec).every((x) => (RECORD_FALLBACK_ICONS as readonly string[]).includes(x)), "picked from the fallback list");
    const again = iconProbe(built("icons-fallback-again", many));
    assert.deepEqual(again.areas, fb.areas, "the same build picks the same icons (deterministic)");
    console.log(`✓ record icons, picked (mold_v0-242): ${f.staff.length} staff and ${f.portal.length} customer Records entries, each its own icon, none another staff entry's; the same each build`);

    // b. The customer tab's: its own tab's sidebar icon, else the sections or merged tab's that shows it; one another area
    // already took falls back (shared areas choose first).
    const t = iconProbe(built("icons-tabs", ["fixture_vulns", "fixture_status"]));
    holds("tabs", t, { staffClash: true });
    const icon = (p: Probe, n: string) => p.areas.find((a) => a.name === n)!.icon;
    // Packs in build order (fixture_status, then fixture_vulns): req_library takes book before audit_controls asks for it.
    assert.deepEqual([icon(t, "req_library"), icon(t, "audit_findings"), icon(t, "audit_apps"), icon(t, "req_own")], ["book", "shield", "building", "circleCheck"],
      "each its customer tab's icon (a merged tab's for req_own)");
    assert.ok(![...["book", "shield", "building", "circleCheck"]].includes(icon(t, "audit_controls")), `audit_controls' tab icon (book) is req_library's: a fallback (${icon(t, "audit_controls")})`);
    assert.ok(![...["book", "shield", "building", "circleCheck"]].includes(icon(t, "req_status")), `req_status's merged tab icon is req_own's: a fallback (${icon(t, "req_status")})`);
    console.log("✓ record icons, from the customer tab: its own tab's or the merged tab's icon; one another area holds falls back");

    // c. Declared: an area's own icon wins over its tab's; two areas declaring one icon keep it, with a build warning; a
    // tab icon an area declared is a fallback for the area it would have gone to.
    const dec = buildCopy("icons-declared", ["fixture_vulns", "fixture_status"], (id, j) => {
      const area = (n: string) => j.record_areas.find((a: any) => a.name === n);
      if (id === "fixture_vulns") { area("audit_apps").icon = "workspace"; area("audit_controls").icon = "shield"; }
      if (id === "fixture_status") area("req_library").icon = "shield";
    });
    assert.equal(dec.status, 0, `two areas declaring one icon is a warning, not a refusal: ${dec.out.slice(-1500)}`);
    assert.match(dec.out, /gen-packs: warning: 1 icon\(s\) declared by more than one record area \(their Records entries look alike\):\n  shield: fixture_status\/req_library, fixture_vulns\/audit_controls/);
    const d = iconProbe(dec.copy);
    assert.deepEqual([icon(d, "audit_apps"), icon(d, "audit_controls"), icon(d, "req_library")], ["workspace", "shield", "shield"], "their own icons, over their tabs'");
    assert.notEqual(icon(d, "audit_findings"), "shield", "its tab's icon is declared by another area: a fallback");
    assert.equal(records(d.adminNav, "admin").filter((i: any) => i.icon === "shield").length, 2, "the declared duplicate shows as declared");
    const quiet = buildCopy("icons-quiet", ["fixture_vulns"]);
    assert.doesNotMatch(quiet.out, /declared by more than one record area/, "no warning without a duplicate");
    const bad = buildCopy("icons-bad", ["fixture_vulns"], (_id, j) => { j.record_areas[0].icon = "landmark"; });
    assert.notEqual(bad.status, 0, "an icon outside the set is refused");
    assert.match(bad.out, /record_areas\[0\]\.icon/, `refused at the area's icon: ${bad.out.slice(-600)}`);
    console.log("✓ record icons, declared: its own wins; two areas declaring one keep it with a build warning; an icon outside the set is refused");

    // d. The rule alone: more areas than the fallback list still get one each (repeating only past its end); a hash start.
    const lots = Array.from({ length: RECORD_FALLBACK_ICONS.length + 3 }, (_x, k) => ({ name: `area_${k}`, scope: k % 2 ? "workspace" : "platform" }));
    const got = recordAreaIcons(lots);
    assert.equal(new Set(Object.values(got)).size, RECORD_FALLBACK_ICONS.length, "every fallback icon used once before any repeats");
    assert.deepEqual(recordAreaIcons([{ name: "a", icon: "page" }, { name: "b" }], { tabIcons: { b: "page" }, fallback: ["page", "post"] }), { a: "page", b: "post" }, "a taken tab icon falls back");
    assert.deepEqual(recordAreaIcons([{ name: "a" }], { staffIcons: ["page"], avoidIcons: ["post"], fallback: ["page", "post"] }).a, "post", "a staff entry's icon is never picked while another is free, even one the customer sidebar shows");
    assert.deepEqual(recordIconDuplicates([{ name: "a", icon: "page" }, { name: "b", icon: "page" }, { name: "c", icon: "post" }, { name: "d" }]), [{ icon: "page", areas: ["a", "b"] }]);
    console.log("✓ record icons, the rule: distinct while the list lasts; a staff entry's icon last of all; duplicates named");
  }
  // ---------- 9. the staff Records group from config (mold_v0-271) ----------
  {
    const NAV_PROBE = `import { adminNav, portalNav } from '@/config/nav-config';
import { recordAreas } from '@/config/pack-nav.generated';
import { features } from '@/config/features.generated';
import { activeNavUrl, navOptions, navUrls } from '@/lib/active-nav';
const urls = navUrls(adminNav, []);
const lit = (u: string) => activeNavUrl(u, urls, navOptions('admin'));
process.stdout.write('\\u0001' + JSON.stringify({ adminNav, portalNav, areas: recordAreas.map((a) => a.name), features,
  lit: { regulators: lit('/admin/records/regulators'), regulator: lit('/admin/records/regulators/rbi'), controls: lit('/admin/records/controls'), journeys: lit('/admin/journeys'), recipes: lit('/admin/recipes') } }));
`;
    type Probe = { adminNav: any[]; portalNav: any[]; areas: string[]; features: Record<string, boolean>; lit: Record<string, string | null> };
    const navProbe = (c: string): Probe => {
      const web = path.join(c, "web"), file = path.join(web, "probe-records-group.tsx");
      writeFileSync(file, NAV_PROBE);
      try {
        const r = spawnSync(TSX, ["--tsconfig", path.join(web, "tsconfig.json"), file], { cwd: web, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        assert.equal(r.status, 0, `records group probe: ${r.stderr.slice(0, 2000)}`);
        return JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1));
      } finally { rmSync(file, { force: true }); }
    };
    const group = (p: Probe, label: string) => (p.adminNav.find((g: any) => g.label === label)?.items ?? []).map((i: any) => `${i.title} ${i.url}`);
    const everywhere = (p: Probe, url: string) => p.adminNav.flatMap((g: any) => g.items.filter((i: any) => i.url === url).map(() => g.label));
    const PACKS = ["fixture_catalog", "fixture_journeys"];
    const declare = (show: unknown[]) => (id: string, j: any) => { if (id === "fixture_catalog") j.console = { ...(j.console ?? {}), admin_records: { show } }; };

    // a. Undeclared: every shared area, Journeys in its own Engagement group (as before).
    const base = navProbe(built("records-default", PACKS));
    assert.deepEqual(group(base, "Records"), ["Regulators /admin/records/regulators", "Controls /admin/records/controls"], "undeclared: every shared area, in pack order");
    assert.deepEqual(everywhere(base, "/admin/journeys"), ["Engagement"], "undeclared: Journeys in its Engagement group");

    // b. A pack declares it: exactly its entries, a shell page among them, an area relabelled; Journeys moved, at its address.
    const p = navProbe(built("records-declared", PACKS, declare(["journeys", { id: "controls", label: "Control library" }])));
    assert.deepEqual(group(p, "Records"), ["Pipelines /admin/journeys", "Control library /admin/records/controls"], "exactly the declared entries, in order, relabelled where it says (Journeys in the pack's own word for them)");
    assert.deepEqual(everywhere(p, "/admin/journeys"), ["Records"], "Journeys left Engagement for Records (once, at the same address)");
    assert.ok(!p.adminNav.some((g: any) => g.label === "Engagement"), "a group left empty goes");
    assert.equal(p.lit.journeys, "/admin/journeys", "Journeys is lit in its new place");
    assert.equal(p.lit.controls, "/admin/records/controls");
    // A shared area left out: not in the staff sidebar, still a page of the build and still in the customer's Records.
    assert.deepEqual(everywhere(p, "/admin/records/regulators"), [], "a shared area left out is not in the staff sidebar");
    assert.ok(p.areas.includes("regulators"), "its spec stays: its staff list and record pages, its API and MCP tools are the build's as before");
    assert.ok(p.portalNav.flatMap((g: any) => g.items).some((i: any) => i.url === "/app/records/regulators"), "and the customer sidebar keeps it");
    assert.equal(p.lit.regulators, null, "opened by link, it lights no other entry");
    assert.equal(p.lit.regulator, null, "nor does one of its records");
    // The rest of the staff sidebar is as it was.
    assert.deepEqual(p.adminNav.filter((g: any) => !["Records", "Engagement"].includes(g.label)), base.adminNav.filter((g: any) => !["Records", "Engagement"].includes(g.label)), "every other group unchanged");

    // c. The profile's wins over a pack's.
    const prof = navProbe(built("records-profile", PACKS, declare(["journeys"]), { console: { admin_records: { show: ["regulators"] } } }));
    assert.deepEqual(group(prof, "Records"), ["Regulators /admin/records/regulators"], "the profile's list over the pack's");
    assert.deepEqual(everywhere(prof, "/admin/journeys"), ["Engagement"], "Journeys stays where it was when the group does not list it");

    // d. The Recipes page: with the workspace agent on it asks for workspace_recipes (quiet otherwise).
    assert.ok(!("workspace_recipes" in base.features), "undeclared: workspace_recipes is not in the console's flags (quiet while off)");
    const rec = navProbe(built("records-recipes", PACKS, declare(["recipes", "journeys", "controls"]), { features: { agent_harness: true } }));
    assert.deepEqual(group(rec, "Records"), ["Recipes /admin/recipes", "Pipelines /admin/journeys", "Controls /admin/records/controls"]);
    assert.equal(rec.features.workspace_recipes, true, "listed, with the workspace agent on: workspace_recipes is on");
    assert.equal(rec.lit.recipes, "/admin/recipes");

    // e. Refused, each with its reason.
    const refused: [string, unknown[], RegExp, unknown?][] = [
      ["unknown", ["journeys", "nothing_here"], /no shared record area is named nothing_here/],
      ["recipes-no-agent", ["recipes"], /the workspace agent is off/],
      ["twice", ["controls", "controls"], /listed twice/],
      ["profiles-no-agent", ["agent-profiles"], /workspace agent is off/],
      ["bad-label", [{ id: "controls", label: "{x}" }], /label|Invalid/],
    ];
    for (const [name, show, re] of refused) {
      const b = buildCopy(`records-${name}`, PACKS, declare(show));
      assert.notEqual(b.status, 0, `${name}: refused`);
      assert.match(b.out, re, `${name}: ${b.out.slice(-800)}`);
    }
    const ws = buildCopy("records-ws-area", ["fixture_catalog", "fixture_vulns"], (id, j) => { if (id === "fixture_catalog") j.console = { admin_records: { show: ["controls", "audit_apps"] } }; });
    assert.notEqual(ws.status, 0);
    assert.match(ws.out, /audit_apps: holds each workspace's own records/, ws.out.slice(-800));
    const two = buildCopy("records-two-packs", ["fixture_catalog", "fixture_vulns"], (_id, j) => { j.console = { ...(j.console ?? {}), admin_records: { show: ["controls"] } }; });
    assert.notEqual(two.status, 0);
    assert.match(two.out, /both declare the staff Records group/, two.out.slice(-800));
    console.log("✓ the staff Records group from config: exactly its entries in its order (areas relabelled, Journeys and Recipes placed there and lit there, gone from their own group); a shared area left out keeps its page, spec and customer entry and lights nothing; the profile's over a pack's; refusals (unknown, a workspace area, a page the build lacks, twice, two packs)");
  }
  console.log("CONSOLE SIDEBAR TEST PASS");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
