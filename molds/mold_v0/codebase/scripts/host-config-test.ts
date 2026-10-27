// A host pack's console nav, Setup page, settings, admin MCP words and redirects as pack.json config (mold_v0-140), and the
// session engine's account-stage words (mold_v0-121), offline: throwaway build copies for what gen-packs writes and
// refuses, then the server's modules in this process (an embedded database, the offline Clerk) for what it does with them.
//   npm run test:host-config
//
// 1. A host pack's pack.json console.nav places its entries among the shell's sidebars: a new group before or after a
//    group, entries into a group before or after an entry (at the end when the anchor is missing), each with its icon and
//    shortcut; console.components turns the shell's components on (hostFeature); host.profile.sign_up_subtitle reaches the
//    console's profile; console.redirects are next.config redirects. settings, admin_mcp, setup and mcp.error_hints reach
//    the server as src/hosts.generated.ts PACK_CONFIG (without their $comment); a build declaring none writes
//    hosts.generated.ts and pack-host-nav.generated.ts as before.
// 2. Refused, each naming the pack and the declaration: the old nav.ts and routes.json redirects; a nav entry that is not
//    one of the pack's own pages; nav or setup from a pack that is not a host pack; a shortcut twice; a settings group the
//    shell has, a key two packs declare, a setting in no group; a reword of a tool the shell lacks, two packs rewording one
//    tool, a summary template that does not parse; a skill the shell lacks, a skill step it no longer reads; a setup step
//    after a step there is not, a stage step without the session engine, a launch step without a viewer note; and
//    account_stages from a pack that does not own the engine's tables; a shell text the shell does not have, one two packs
//    write, one with a placeholder that is not the build's; a host.schema label of a table it does not declare.
// 4. Shell texts (mold_v0-141): a pack's server texts reach PACK_CONFIG, its console texts build-facts TEXTS (none: the
//    file as before); the server fills a pack's text, else the shell's neutral one; the console the same.
// 3. The server: the packs' settings in their groups and places, a key the shell has refused; a shell tool reworded (its
//    summary a template of the result's fields: summaryValues), a skill's steps replaced in pack order, a step the skill no
//    longer reads refused loudly; the Setup page with the pack's steps (a resource read, optional, the text-only help),
//    the shell steps in its words, the workflow's coverage and next group, a hint per error, and a viewer's note on a
//    launch step; with no config, the shell's own page exactly.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup as cleanupWorld, STAMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = mkdtempSync(path.join(tmpdir(), "host-config-"));
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
let n = 0;

/** A throwaway copy of this codebase (its node_modules linked) with these packs, console files and profile; gen-packs run in it. */
function world(packs: Record<string, Record<string, string>>, profile: Record<string, unknown> = {}, web: Record<string, string> = {}) {
  const dir = path.join(TMP, `w${++n}`);
  for (const p of ["src", "scripts", "web/src", "web/scripts", "docs", "sql", "orchestrator", "package.json", "tsconfig.json", "web/package.json", "web/tsconfig.json"])
    cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true, filter: (f) => !f.split(path.sep).includes("node_modules") });
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  symlinkSync(path.join(ROOT, "web", "node_modules"), path.join(dir, "web", "node_modules"));
  for (const [id, files] of Object.entries(packs)) for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, "packs", id, f)), { recursive: true });
    writeFileSync(path.join(dir, "packs", id, f), text);
  }
  for (const [f, text] of Object.entries(web)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); }
  writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile));
  const gen = spawnSync(process.execPath, [path.join(dir, "scripts", "gen-packs.mjs")], { cwd: dir, encoding: "utf8" });
  return { dir, status: gen.status, out: `${gen.stdout}\n${gen.stderr}` };
}
const read = (dir: string, f: string) => readFileSync(path.join(dir, f), "utf8");
/** The console's sidebars, components and profile, read through tsx with the console's tsconfig. */
function consoleOf(dir: string) {
  const web = path.join(dir, "web"), file = path.join(web, "probe-host-config.tsx");
  writeFileSync(file, `import { portalNav, adminNav } from '@/config/nav-config';
import { hostFeature } from '@/features/packs/host-nav';
import { profile } from '@/config/profile.generated';
process.stdout.write('\\u0001' + JSON.stringify({ portalNav, adminNav, features: ['tips', 'journeys', 'research'].filter(hostFeature), profile }));
`);
  try {
    const r = spawnSync(TSX, ["--tsconfig", path.join(web, "tsconfig.json"), file], { cwd: web, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `console probe: ${r.stderr.slice(0, 2000)}`);
    return JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1)) as { portalNav: { label: string; items: Record<string, unknown>[] }[]; adminNav: { label: string; items: Record<string, unknown>[] }[]; features: string[]; profile: Record<string, unknown> };
  } finally { rmSync(file, { force: true }); }
}

const HOST_WEB = {
  "web/src/packs/hosty/index.ts": "export default { id: 'hosty' };\n",
  "web/src/packs/hosty/routes.json": JSON.stringify({ app: ["alpha", "beta", "beta/deep", "zeta", "omega"], admin: ["gamma", "delta"] }),
};
const item = (title: string, url: string, icon: string, key?: string) => ({ title, url, icon, ...(key ? { shortcut: ["g", key] } : {}) });
const NAV = {
  app: [
    { into: "Insights", after: "/app/usage", items: [item("Alpha", "/app/alpha", "trendingUp", "v")] },
    { $comment: "a new group before the shell's Operational", label: "Hosted", before: "Operational", items: [item("Beta", "/app/beta", "userPen", "y"), item("Deep", "/app/beta/deep", "kanban")] },
    { into: "Insights", before: "/app/nowhere", items: [item("Zeta", "/app/zeta", "code")] },
    { label: "Last", after: "No such group", items: [item("Omega", "/app/omega", "route")] },
  ],
  admin: [
    { label: "Engagement", after: "Onboarding", items: [item("Gamma", "/admin/gamma", "route", "j")] },
    { into: "Operations", before: "/admin/finops", items: [item("Delta", "/admin/delta", "code")] },
  ],
};
const CONFIG = {
  settings: { $comment: "x", groups: [{ id: "hosted", label: "Hosted", after: "runs" }],
    defs: [{ key: "HOSTY_SAMPLES", group: "runs", label: "Samples", kind: "int", default: 10, min: 1, max: 100, help: "How many.", before: "APP_MAX_SESSIONS_PER_RUN" },
      { key: "HOSTY_MODE", group: "hosted", label: "Mode", kind: "choice", default: "on", options: ["on", "off"], help: "On or off." }] },
  admin_mcp: { reword: { get_account: { description: "One account in Hosty's words.", summary_template: "{account_name}: {members_count} member(s)." } },
    skills: { ops_review: [{ from: "2. list_access_requests with status 'pending'.", to: "2. hosty_check. 3. list_access_requests with status 'pending'." }] } },
  setup: {
    shell_steps: { first_call: { help: "Ask Hosty anything. Type: \"Hosty, start.\"" } },
    steps: [{ id: "widget", after: "tools", label: "See the widget", optional: true, done_when: "resource:ui://hosty/", help: "Ask in Claude and a widget renders.", help_text_only: "Your client shows text.", prompt: "Show the widget." },
      { id: "launch_it", label: "Launch something", launch: true, done_when: "resource:ui://hosty/launched", help: "Launch it. Type: \"Launch.\"" }],
    viewer_note: "Viewers watch; a Member launches.",
    workflow: [{ id: "start", label: "Start", tools: ["hosty_start"], prompt: "Start Hosty." }, { id: "go", label: "Go", tools: ["hosty_go", "hosty_more"], prompt: "Go." }],
  },
  mcp: { error_hints: [{ match: "budget", text: "Raise the budget." }, { match: "no (thing|things)", text: "Make a thing first." }] },
};
const hostPack = (extra: Record<string, unknown> = {}) => ({
  "pack.json": JSON.stringify({ id: "hosty", name: "Hosty", version: "1", host: { entry: "host.ts", profile: { name: "Hosty", sign_up_subtitle: "Host things well" } }, ...extra }),
  "host.ts": `import { defineHost } from "../../src/pack-host.js";\nexport default defineHost({ id: "hosty" });\n`,
});
const HOST_PROFILE = { host_packs: ["hosty"] };

try {
  // ---------- 1. what a host pack's config becomes ----------
  const plain = world({ hosty: hostPack() }, HOST_PROFILE, { "web/src/packs/hosty/index.ts": HOST_WEB["web/src/packs/hosty/index.ts"] });
  assert.equal(plain.status, 0, plain.out);
  const zero = world({});
  assert.equal(zero.status, 0, zero.out);
  for (const f of ["web/src/config/pack-host-nav.generated.ts", "src/hosts.generated.ts"]) assert.equal(read(zero.dir, f), read(ROOT, f), `${f}: zero packs, as committed`);
  assert.equal(read(plain.dir, "web/src/config/pack-host-nav.generated.ts"), read(zero.dir, "web/src/config/pack-host-nav.generated.ts"), "a host pack with no console config: no host nav");
  assert.doesNotMatch(read(plain.dir, "src/hosts.generated.ts"), /PACK_CONFIG/, "and no PACK_CONFIG");
  const base = consoleOf(plain.dir);

  const full = world({ hosty: hostPack({ console: { nav: NAV, components: ["research"], redirects: [{ source: "/app/old", destination: "/app/alpha", permanent: true }, { source: "/app/older/:path*", destination: "/app/beta/:path*" }] }, ...CONFIG }) }, HOST_PROFILE, HOST_WEB);
  assert.equal(full.status, 0, full.out);
  const c = consoleOf(full.dir);
  const labels = (g: { label: string }[]) => g.map((x) => x.label);
  const urls = (g: { items: Record<string, unknown>[] }) => g.items.map((i) => i.url);
  assert.deepEqual(labels(c.portalNav), [...labels(base.portalNav).slice(0, -1), "Hosted", ...labels(base.portalNav).slice(-1), "Last"], "a new group before Operational; one after a group the sidebar lacks goes last");
  const insights = c.portalNav.find((g) => g.label === "Insights")!;
  assert.deepEqual(urls(insights), ["/app/usage", "/app/alpha", "/app/zeta"], "into a group after an entry; before a missing entry: at the group's end");
  assert.deepEqual(insights.items[1], { title: "Alpha", url: "/app/alpha", icon: "trendingUp", shortcut: ["g", "v"], items: [] }, "an entry as the sidebar's own: icon, shortcut, no children");
  assert.deepEqual(c.portalNav.find((g) => g.label === "Hosted")!.items.map((i) => [i.title, i.icon, i.shortcut ?? null]), [["Beta", "userPen", ["g", "y"]], ["Deep", "kanban", null]]);
  assert.deepEqual(labels(c.adminNav).slice(0, 2), ["Onboarding", "Engagement"], "a new admin group after Onboarding");
  assert.deepEqual(urls(c.adminNav.find((g) => g.label === "Operations")!).slice(0, 3), ["/admin/compute", "/admin/delta", "/admin/finops"], "an entry before FinOps");
  assert.deepEqual(c.features, ["research"], "the components the pack names (tips and journeys are the shell's own since mold_v0-143: pack.json tips, journeys)");
  assert.deepEqual(base.features, [], "none without");
  assert.equal(c.profile.sign_up_subtitle, "Host things well", "the sign-up subtitle from the host's profile");
  const routes = JSON.parse(read(full.dir, "web/src/config/pack-routes.generated.json"));
  assert.deepEqual(routes.redirects.slice(0, 2), [{ source: "/app/old", destination: "/app/alpha", permanent: true }, { source: "/app/older/:path*", destination: "/app/beta/:path*", permanent: true }], "redirects first, permanent unless it says false");
  const hosts = read(full.dir, "src/hosts.generated.ts");
  const pc = JSON.parse(hosts.slice(hosts.indexOf("PACK_CONFIG: readonly unknown[] = ") + "PACK_CONFIG: readonly unknown[] = ".length, hosts.lastIndexOf(";")));
  assert.deepEqual(Object.keys(pc[0]), ["pack", "settings", "admin_mcp", "error_hints", "setup"]);
  assert.equal("$comment" in pc[0].settings || "$comment" in pc[0].setup, false, "no $comment reaches the server");
  assert.deepEqual(pc[0].error_hints, CONFIG.mcp.error_hints);
  console.log("✓ a host pack's console.nav places its entries (groups and entries, anchors, icons, shortcuts), components, sign-up subtitle and redirects; its server config is PACK_CONFIG; none declared, nothing written");

  // ---------- 2. refusals ----------
  const refused = (what: string, packs: Record<string, Record<string, string>>, re: RegExp, web: Record<string, string> = HOST_WEB, profile: Record<string, unknown> = HOST_PROFILE) => {
    const r = world(packs, profile, web);
    assert.equal(r.status, 1, `${what}: refused (${r.out.slice(-600)})`);
    assert.match(r.out, re, `${what}: refused with ${re}\n${r.out.slice(-800)}`);
  };
  const decl = (extra: Record<string, unknown>) => ({ "pack.json": JSON.stringify({ id: "plainpack", name: "Plain", version: "1", ...extra }) });
  refused("the old nav.ts", { hosty: hostPack() }, /web\/src\/packs\/hosty\/nav\.ts: the sidebar entries are pack\.json console\.nav/, { ...HOST_WEB, "web/src/packs/hosty/nav.ts": "export const features = [];\n" });
  refused("routes.json redirects", { hosty: hostPack() }, /routes\.json: redirects are pack\.json console\.redirects \(mold_v0-140\)/,
    { ...HOST_WEB, "web/src/packs/hosty/routes.json": JSON.stringify({ app: ["alpha"], redirects: [{ source: "/a", destination: "/b" }] }) });
  refused("a nav entry that is not the pack's page", { hosty: hostPack({ console: { nav: { app: [{ label: "X", items: [item("Billing", "/app/billing", "billing")] }] } } }) },
    /console\.nav\.app\[0\]\.items\[0\]: \/app\/billing is not one of the pack's own \/app pages/);
  refused("nav from a declarative pack", { hosty: hostPack(), plainpack: decl({ console: { nav: { app: [{ label: "X", items: [item("A", "/app/alpha", "page")] }] } } }) },
    /packs\/plainpack\/pack\.json: console\.nav and console\.components are a host pack's/);
  refused("a shortcut twice", { hosty: hostPack({ console: { nav: { app: [{ label: "X", items: [item("A", "/app/alpha", "page", "q"), item("B", "/app/beta", "page", "q")] }] } } }) }, /shortcut g q is \/app\/alpha's too/);
  refused("label and into", { hosty: hostPack({ console: { nav: { app: [{ label: "X", into: "Y", items: [item("A", "/app/alpha", "page")] }] } } }) }, /either label \(a new group\) or into/);
  refused("an icon the console lacks", { hosty: hostPack({ console: { nav: { app: [{ label: "X", items: [item("A", "/app/alpha", "unicorn")] }] } } }) }, /console\.nav\.app\[0\]\.items\[0\]\.icon/);
  refused("a settings group the shell has", { hosty: hostPack({ settings: { groups: [{ id: "runs", label: "Runs again" }] } }) }, /settings\.groups runs: the shell has a group runs/);
  refused("a setting two packs declare", { hosty: hostPack({ settings: { defs: [CONFIG.settings.defs[0]] } }), plainpack: decl({ settings: { defs: [CONFIG.settings.defs[0]] } }) },
    /packs\/plainpack\/pack\.json: settings\.defs HOSTY_SAMPLES: pack hosty has that setting/);
  refused("a setting in no group", { hosty: hostPack({ settings: { defs: [{ ...CONFIG.settings.defs[0], group: "nowhere" }] } }) }, /settings\.defs HOSTY_SAMPLES: group nowhere is not one of the build's/);
  refused("a choice whose default is not an option", { hosty: hostPack({ settings: { defs: [{ ...CONFIG.settings.defs[1], group: "runs", default: "maybe" }] } }) }, /a choice's default is one of its options/);
  refused("a reword of a tool the shell lacks", { hosty: hostPack({ admin_mcp: { reword: { list_widgets: { description: "Widgets, all of them." } } } }) }, /admin_mcp\.reword list_widgets: not one of the shell's admin tools/);
  refused("two packs rewording one tool", { hosty: hostPack({ admin_mcp: { reword: { get_account: { description: "One, by Hosty." } } } }), plainpack: decl({ admin_mcp: { reword: { get_account: { description: "One, plainly." } } } }) },
    /packs\/plainpack\/pack\.json: admin_mcp\.reword get_account: pack hosty rewords it too/);
  refused("a summary template that does not parse", { hosty: hostPack({ admin_mcp: { reword: { get_account: { summary_template: "{?account_name}open" } } } }) }, /summary_template: \{\?account_name\} or \{!account_name\} is never closed/);
  refused("a skill the shell lacks", { hosty: hostPack({ admin_mcp: { skills: { weekly_review: [{ from: "1. health_summary with failures: true.", to: "x" }] } } }) }, /admin_mcp\.skills weekly_review: not one of the shell's admin skills/);
  refused("a skill step the skill no longer reads", { hosty: hostPack({ admin_mcp: { skills: { ops_review: [{ from: "1. health_summary with failures: false.", to: "x" }] } } }) },
    /admin_mcp\.skills ops_review\[0\]\.from: the shell's skill no longer reads "1\. health_summary with failures: false\."/);
  refused("setup from a declarative pack", { hosty: hostPack(), plainpack: decl({ setup: { viewer_note: "No." } }) }, /packs\/plainpack\/pack\.json: setup is a host pack's/);
  refused("a setup step after a step there is not", { hosty: hostPack({ setup: { steps: [{ ...CONFIG.setup.steps[0], after: "dashboard" }] } }) }, /setup\.steps\[0\] widget: after: dashboard is not a step before it/);
  refused("a shell step as the pack's own", { hosty: hostPack({ setup: { steps: [{ ...CONFIG.setup.steps[0], id: "tools" }] } }) }, /is one of the shell's steps: give its words in setup\.shell_steps/);
  refused("a stage step without the session engine", { hosty: hostPack({ setup: { steps: [{ ...CONFIG.setup.steps[0], done_when: "stage:onboarded" }] } }) }, /done_when stage: the build has no session engine/);
  refused("a launch step without a viewer note", { hosty: hostPack({ setup: { steps: [CONFIG.setup.steps[1]] } }) }, /launch: give setup\.viewer_note/);
  refused("a tool in two workflow groups", { hosty: hostPack({ setup: { workflow: [{ id: "aa", label: "A", tools: ["tt"], prompt: "A." }, { id: "bb", label: "B", tools: ["tt"], prompt: "B." }] } }) }, /setup\.workflow bb: tool tt is in group aa too/);
  refused("an error hint that does not compile", { hosty: hostPack({ mcp: { error_hints: [{ match: "(", text: "Fix it." }] } }) }, /error_hints\[0\]\.match: a regular expression that compiles/);
  refused("account_stages without the engine", { hosty: hostPack({ account_stages: { first_next: "Do it", stages: ["onboarded", "simulated", "reported"].map((id) => ({ id, label: id, next: "n", funnel: id })),
    attention: { failed: "f", first_call: "c", onboarded: "o", simulated: "s" } } }) }, /account_stages: the session engine's stages are the words of the host pack that owns its tables/);
  refused("a shell text the shell does not have", { hosty: hostPack({ texts: { "refusal.nothing": "No." } }) }, /texts/);
  refused("a shell text two packs write", { hosty: hostPack({ texts: { "usage.score": "Hits" } }), plainpack: decl({ texts: { "usage.score": "Points" } }) },
    /packs\/plainpack\/pack\.json: texts usage\.score: pack hosty writes it too/);
  refused("a shell text with a placeholder that is not the build's", { hosty: hostPack({ texts: { "refusal.viewer_launch": "Viewers can't run {sims}." } }) },
    /texts refusal\.viewer_launch: \{sims\} is not a placeholder of the build's words/);
  refused("a label of a table host.schema does not declare", { hosty: hostPack({ migrations: "migrations", host: { entry: "host.ts", schema: { tables: ["things"], labels: { widgets: "Widgets" } } } }) },
    /host\.schema\.labels\.widgets: not one of host\.schema\.tables/);
  console.log("✓ refused: nav.ts and routes.json redirects, a nav entry not the pack's page or from a declarative pack, a shortcut twice, bad settings, rewords and skill steps, bad setup steps and hints, account_stages without the engine, bad shell texts and table labels");

  // ---------- 4. shell texts (mold_v0-141) ----------
  const TEXTS = { $comment: "x", "refusal.viewer_edit": "Hosty viewers look, never touch.", "admin_roles.support": "Viewer, plus Hosty's {runs}.", "usage.score": "Hits", "journeys.one": "tour" };
  const worded = world({ hosty: hostPack({ texts: TEXTS }) }, HOST_PROFILE, { "web/src/packs/hosty/index.ts": HOST_WEB["web/src/packs/hosty/index.ts"] });
  assert.equal(worded.status, 0, worded.out);
  const wh = read(worded.dir, "src/hosts.generated.ts");
  const wpc = JSON.parse(wh.slice(wh.indexOf("PACK_CONFIG: readonly unknown[] = ") + "PACK_CONFIG: readonly unknown[] = ".length, wh.lastIndexOf(";")));
  assert.deepEqual(wpc, [{ pack: "hosty", texts: { "refusal.viewer_edit": TEXTS["refusal.viewer_edit"], "admin_roles.support": TEXTS["admin_roles.support"], "journeys.one": TEXTS["journeys.one"] } }],
    "the server's texts in PACK_CONFIG (and the journeys' nouns, which both sides use since mold_v0-143), no $comment");
  const facts = read(worded.dir, "web/src/config/build-facts.generated.ts");
  assert.match(facts, /export const TEXTS: Readonly<Record<string, string>> = \{\n  "usage\.score": "Hits",\n  "journeys\.one": "tour"\n\};/, "the console's texts in its build facts");
  assert.equal(read(plain.dir, "web/src/config/build-facts.generated.ts"), read(zero.dir, "web/src/config/build-facts.generated.ts"), "no texts: the build facts as before");
  assert.equal(read(zero.dir, "web/src/lib/shell-texts.generated.ts").split("\n").slice(1).join("\n"), read(ROOT, "src/shell-texts.ts"), "the console's copy of the shell's texts");
  // The console's text(): the pack's, filled, else the shell's.
  {
    const web = path.join(worded.dir, "web"), file = path.join(web, "probe-texts.tsx");
    writeFileSync(file, "import { text } from '@/lib/texts';\nprocess.stdout.write('\\u0001' + JSON.stringify(['usage.score', 'journeys.one', 'journeys.many', 'usage.score_description'].map((t) => text(t as never))));\n");
    const r = spawnSync(TSX, ["--tsconfig", path.join(web, "tsconfig.json"), file], { cwd: web, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr.slice(0, 2000));
    assert.deepEqual(JSON.parse(r.stdout.slice(r.stdout.indexOf("\u0001") + 1)), ["Hits", "tour", "guides", "Score of the latest runs in this period."], "the console: a pack's text, else the shell's, filled");
  }
  console.log("✓ shell texts: a pack's server texts in PACK_CONFIG, its console texts in build-facts TEXTS (none declared, the file as before); the console fills a pack's text, else the shell's");

  // ---------- 3. the server ----------
  const host = await import("../src/host.js");
  const settings = await import("../src/settings.js");
  const adm = await import("../src/admin-mcp.js");
  const { summaryValues } = await import("../src/text-template.js");
  const shellSettings = settings.allSettings().map((d) => d.key);
  // The shell's sessions-per-run cap under the key it is stored with (src/settings.ts ENGINE_SETTINGS).
  const CAP = settings.ENGINE_SETTINGS.maxSessionsPerRun;
  const cfg = { pack: "hosty", ...pc[0], settings: { ...pc[0].settings, defs: pc[0].settings.defs.map((d: any) => (d.before ? { ...d, before: CAP } : d)) } };
  host.setPackConfigsForTest([cfg]);
  assert.deepEqual(settings.settingGroups().map((g) => g.id), ["models", "runs", "hosted", "capacity", "docs", "email"], "a pack's group after the one it names");
  const keys = settings.allSettings().map((d) => d.key);
  assert.equal(keys.indexOf("HOSTY_SAMPLES"), keys.indexOf(CAP) - 1, "before the setting it names");
  assert.equal(keys.indexOf("HOSTY_MODE"), keys.indexOf("HOSTY_SAMPLES") + 2, "in its own group, after runs");
  assert.equal(settings.settingNumber("HOSTY_SAMPLES"), 10, "its default in force");
  host.setPackConfigsForTest([{ pack: "hosty", settings: { defs: [{ key: shellSettings[0]!, group: "models", label: "Again", kind: "text", default: "x", help: "x" }] } }]);
  assert.throws(() => settings.allSettings(), /pack hosty: pack\.json settings\.defs ORCHESTRATOR_MODEL is a setting the build already has/);
  host.setPackConfigsForTest([cfg]);
  const tools = adm.adminTools();
  assert.equal(tools.get_account!.description, "One account in Hosty's words.");
  assert.equal(tools.get_account!.summary({ account: { name: "Acme", slug: "acme" }, members: [1, 2, 3] }, {}), "Acme: 3 member(s).", "the summary template filled from the result");
  const ops = adm.skillText("ops_review", adm.ADMIN_SKILLS.ops_review.text());
  assert.ok(ops.includes("1. health_summary with failures: true. 2. hosty_check. 3. list_access_requests with status 'pending'."), ops);
  host.setPackConfigsForTest([{ pack: "hosty", admin_mcp: { skills: { ops_review: [{ from: "no such step at all", to: "x" }] } } }]);
  assert.throws(() => adm.skillText("ops_review", adm.ADMIN_SKILLS.ops_review.text()), /pack hosty: the shell's admin skill ops_review no longer reads "no such step at all…"/);
  assert.deepEqual(summaryValues({ a: { b: "x", c: [1, 2], d: { e: 3, f: { g: 1 } } }, n: null, BAD: 1, "x-y": 2, t: true }),
    { a_b: "x", a_c_count: 2, a_d_e: 3, n: null, t: true }, "paths joined by _, lists counted, three levels, template names only");
  console.log("✓ server: the packs' settings in their groups and places (a shell key refused), get_account reworded with its summary template, skill steps replaced (a missing one refused)");
  // The server's shell texts (mold_v0-141): the pack's, its placeholders filled, else the shell's.
  const { shellText } = await import("../src/texts.js");
  const { accountRefusal } = await import("../src/account-roles.js");
  const { roleHelp } = await import("../src/admin-roles.js");
  host.setPackConfigsForTest([]);
  assert.equal(accountRefusal("edit").message, "Viewers can read but can't make changes. Ask an account owner to change your role on the Team page.", "the shell's own");
  assert.equal(shellText("admin_roles.support"), "Viewer, plus access requests, new accounts and invitations.");
  host.setPackConfigsForTest(wpc);
  assert.equal(accountRefusal("edit").message, "Hosty viewers look, never touch. Ask an account owner to change your role on the Team page.", "the pack's refusal");
  assert.equal(roleHelp("support"), "Viewer, plus Hosty's runs.", "the pack's text, its placeholder filled");
  assert.equal(accountRefusal("launch").message, "Viewers can read reports, usage and transcripts but can't run runs. Ask an account owner to change your role on the Team page.", "a text the pack leaves: the shell's");
  host.setPackConfigsForTest([cfg]);
  console.log("✓ server: shell texts from the pack's pack.json texts, filled, else the shell's own");

  // The Setup page, as the shell's route answers it.
  host.setPackConfigsForTest([]);
  const { startHttp } = await import("./lib/test-world.js");
  const { createOrg } = await import("../src/auth.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const http = await startHttp();
  try {
    const { org } = await createOrg(`Hosty ${STAMP}`);
    const owner = await http.signIn(org, "owner"), viewer = await http.signIn(org, "viewer");
    const setup = async (token: string) => { const r = await http.req("GET", "/api/app/setup", { authorization: `Bearer ${token}` }); assert.equal(r.status, 200); return r.json() as Promise<Record<string, any>>; };
    const shell = await setup(owner);
    assert.deepEqual(shell.steps.map((s: any) => s.id), ["joined", "connected", "tools", "first_call"], "no config: the shell's steps");
    assert.deepEqual([shell.groups, shell.coverage, shell.next, shell.viewer_note], [[], 0, null, null]);
    host.setPackConfigsForTest([cfg]);
    const before = await setup(owner);
    assert.deepEqual(before.steps.map((s: any) => [s.id, s.done, s.optional ?? false]),
      [["joined", true, false], ["connected", false, false], ["tools", false, false], ["widget", false, true], ["first_call", false, false], ["launch_it", false, false]], "its steps among the shell's");
    assert.deepEqual(before.steps.find((s: any) => s.id === "first_call").prompt, "Hosty, start.", "the shell's first step in its words, its prompt from them");
    assert.deepEqual([before.done, before.total], [1, 5], "the optional step is not counted");
    assert.deepEqual(before.groups.map((g: any) => [g.id, g.used, g.total]), [["start", 0, 1], ["go", 0, 2]]);
    assert.equal(before.next.id, "start");
    // The owner's own connector log (rows by the session's user, the token's subject): a text-only client, the widget
    // read, a tool of the first group, three errors.
    const userOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub as string;
    const ev = (method: string, name: string | null, client: string | null, ok = true, error: string | null = null) =>
      db.query("INSERT INTO mcp_events (org_id, method, name, client, ok, error, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)", [org.orgId, method, name, client, ok, error, userOf(owner)]);
    await ev("initialize", null, "cursor 1.0");
    await ev("tools/list", null, null);
    await ev("resources/read", "ui://hosty/widget.html", null);
    await ev("tools/call", "hosty_start", null);
    for (const e of ["Over BUDGET now", "no things yet", "something else"]) await ev("tools/call", "hosty_go", null, false, e);
    const after = await setup(owner);
    assert.deepEqual(after.steps.map((s: any) => [s.id, s.done]), [["joined", true], ["connected", true], ["tools", true], ["widget", true], ["first_call", true], ["launch_it", false]], "a resource read under its prefix does the step");
    const widget = after.steps.find((s: any) => s.id === "widget");
    assert.deepEqual([widget.help, widget.prompt], ["Your client shows text.", "Show the widget."], "a text-only client: the text-only help; the declared prompt");
    assert.deepEqual([after.done, after.total], [4, 5], "the optional step done but not counted; the launch step still to do");
    assert.deepEqual(after.groups.map((g: any) => [g.id, g.used]), [["start", 1], ["go", 0]], "the account's tools in use, by group (a failed call is not use)");
    assert.equal(after.coverage, 0.5);
    assert.equal(after.next.id, "go");
    assert.deepEqual(after.errors.map((e: any) => e.hint), [null, "Make a thing first.", "Raise the budget."], "each error its pack's hint, any case (newest first); none matching, none");
    await ev("initialize", null, "claude-ai 0.1");
    assert.equal((await setup(owner)).steps.find((s: any) => s.id === "widget").help, "Ask in Claude and a widget renders.", "a widget-drawing client: the step's own help");
    const v = await setup(viewer);
    assert.equal(v.viewer_note, "Viewers watch; a Member launches.");
    assert.deepEqual([v.steps.find((s: any) => s.id === "launch_it").help, v.steps.find((s: any) => s.id === "launch_it").prompt], ["Viewers watch; a Member launches.", null], "a launch step shows the viewer note");
    assert.equal(after.viewer_note, null, "an owner sees none");
    console.log("✓ server: the Setup page with the pack's steps among the shell's, the shell steps in its words, the workflow's coverage and next group, the viewer note on a launch step; no config, the shell's own page");
  } finally { await http.close(); }
} finally {
  rmSync(TMP, { recursive: true, force: true });
  cleanupWorld();
}
console.log("host-config: ok");
