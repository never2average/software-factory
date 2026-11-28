// mold_v0-348: the fixes from a console's end-to-end audit (each action does what it says, each record's panel says
// the right facts), checked offline: no database, no server.
//   npm run test:e2e-fixes        offline, a few seconds
//   1. A start_agent's first message: a reference by its record's title with its key, an option by its label, a line
//      whose every value is empty left out (src/agent-profile-spec.ts templateRecord, fillTemplate).
//   2. A connection's Test in a test world never calls a real service (src/connection-test.ts testWorldWithoutStandin),
//      a bucket's only on this machine (src/workspace-storage.ts); a 400 says the token may be wrong.
//   3. A connect tab says why a service has no Connect (TabConnectSchema unavailable; src/tab-connect.ts reason).
//   4. Words: the access log names a list's Ask AI and the agent; a refused origin is a sentence.
//   5. The console's source: a list's ?linked= matches the stored key; a flag never set reads No; a person by name; a
//      record deleted from a list's panel stays on that list; a related row opens in the panel; Used by lists its
//      records; a move's toast names the state; a confirm that cancels offers Keep it; Settings › Credentials asks only
//      what is mounted; Billing's People panel is titled and has Remove person; a disabled button says why; a
//      connection's Needs attention says why; Disconnect's body does not ask a second question.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const ok = (m: string) => console.log(`✓ ${m}`);

// ---------- 1. the first message ----------
{
  const { fillTemplate, templateRecord } = await import("../src/agent-profile-spec.js");
  const fields = [
    { name: "compute", type: "reference" }, { name: "identity", type: "reference" }, { name: "repository", type: "reference" },
    { name: "mode", type: "enum", options: [{ value: "custom", label: "Custom" }, { value: "native", label: "Native" }] },
    { name: "platforms", type: "enum", options: [{ value: "web", label: "Web" }, { value: "api", label: "API" }] },
    { name: "harness_version", type: "text" },
  ];
  const record = { key: "example-app", title: "Example app", data: { compute: "fly-io", identity: "", repository: "gone-repo", mode: "custom", platforms: ["web", "api"] },
    ref_titles: { compute: { "fly-io": "Fly.io" } } };
  const words = templateRecord(fields, record);
  assert.equal(words.data.compute, "Fly.io (fly-io)", "a reference by its title, its key after it");
  assert.equal(words.data.repository, "gone-repo", "a reference whose title the person may not read (or that is gone) keeps its key");
  assert.equal(words.data.mode, "Custom", "an option by its label");
  assert.deepEqual(words.data.platforms, ["Web", "API"], "each of a list's options by its label");
  assert.equal(record.data.compute, "fly-io", "the record itself is left as it was");
  const msg = fillTemplate("Build {{title}}.\nCompute: {{compute}}.\nIdentity: {{identity}}.\nHarness version: {{harness_version}}.\nMode: {{mode}}. Platforms: {{platforms}}.", words);
  assert.equal(msg, "Build Example app.\nCompute: Fly.io (fly-io).\nMode: Custom. Platforms: Web, API.", "empty lines left out, no dangling \"Identity: .\"");
  const routes = src("src/record-page-routes.ts");
  assert.equal((routes.match(/templateRecord\(area\.fields, \(await withRefTitles\(/g) ?? []).length, 2, "the preview and the start both fill it from the record's titles");
  ok("a first message names references by title and options by label, and leaves out lines with nothing to say");
}

// ---------- 2. a test world calls no real service ----------
{
  const C = await import("../src/connection-test.js");
  const before = { world: process.env.APP_TEST_WORLD, standin: process.env.APP_CONNECTION_TEST_STANDIN };
  process.env.APP_TEST_WORLD = "1"; delete process.env.APP_CONNECTION_TEST_STANDIN;
  assert.equal(C.testWorldWithoutStandin(), true, "a test world without a stand-in: no real call");
  process.env.APP_CONNECTION_TEST_STANDIN = "http://127.0.0.1:9";
  assert.equal(C.testWorldWithoutStandin(), false, "with a stand-in on this machine: the stand-in answers, as before");
  delete process.env.APP_TEST_WORLD; delete process.env.APP_CONNECTION_TEST_STANDIN;
  assert.equal(C.testWorldWithoutStandin(), false, "outside a test world (production): the real call, unchanged");
  if (before.world !== undefined) process.env.APP_TEST_WORLD = before.world;
  if (before.standin !== undefined) process.env.APP_CONNECTION_TEST_STANDIN = before.standin;
  assert.match(C.TEST_WORLD_WORDS, /^It wasn't tested: this is a test world/, "it says so in words");
  const t = src("src/connection-test.ts");
  assert.match(t, /\} else if \(testWorldWithoutStandin\(\)\) \{\s*result = \{ ok: false, outcome: "not_ready"/, "the record's Test answers before any probe runs (could not test: never failing)");
  const ws = src("src/workspace-storage.ts");
  assert.match(ws, /ENV\.APP_TEST_WORLD === "1" && !loopback\) throw/, "a bucket's Test, too, except one on this machine");
  assert.match(C.statusWords(400), /the token, or a field this test uses, is probably wrong/, "a 400 says the token may be wrong");
  ok("a connection's or a bucket's Test in a test world never reaches a real service; production is unchanged");
}

// ---------- 3. why a service has no Connect ----------
{
  const { TabConnectSchema } = await import("../src/pack-api.js");
  const base = { area: "conns", via: "block", when: { field: "hosting", equals: "saas" } };
  assert.ok(TabConnectSchema.safeParse({ ...base, unavailable: [{ when: { field: "category", equals: "runtime" }, reason: "Builds cannot deploy to it yet." }] }).success, "unavailable: a condition and its words");
  assert.ok(!TabConnectSchema.safeParse({ ...base, unavailable: [{ when: { field: "category", equals: "runtime" }, reason: "two\nlines" }] }).success, "its words are one plain line");
  assert.ok(!TabConnectSchema.safeParse({ ...base, unavailable: [] }).success, "at least one when declared");
  const tc = src("src/tab-connect.ts");
  assert.match(tc, /const reason = connectable \? undefined : \(c\.unavailable \?\? \[\]\)\.find\(\(u\) => conditionHolds\(u\.when, r\.data\)\)\?\.reason;/, "the first that holds, only for a service with no Connect");
  assert.match(src("web/src/features/tabs/connect.tsx"), /\{c\.reason \?\? 'No account to connect for this one: it is not a hosted service with a key of its own\.'\}/, "the panel says it, else the shell's words");
  const fixture = JSON.parse(src("scripts/fixtures/packs/fixture_console/pack.json")) as { tabs: { connect?: { unavailable?: unknown[] } }[] };
  assert.ok(fixture.tabs.some((t) => t.connect?.unavailable?.length), "the console types fixture declares it");
  ok("a connect tab says why a service has no Connect, in its own words");
}

// ---------- 4. words ----------
{
  const { pageName } = await import("../src/audit-words.js");
  assert.equal(pageName("/api/app/list/answer"), "a list's Ask AI");
  assert.equal(pageName("/api/app/list/answer/stream"), "a list's Ask AI");
  assert.equal(pageName("/api/agent/icon"), "the agent's icon");
  assert.equal(pageName("/api/agent/sessions"), "the workspace agent");
  const { checkOrigin } = await import("../src/developer-sessions.js");
  assert.throws(() => checkOrigin("http://insecure.example.com"), (e: Error) => /^Only an https origin can be allowed/.test(e.message), "a refused origin is a sentence, no field name before it");
  ok("the access log names a list's Ask AI and the agent; a refused origin is a sentence");
}

// ---------- 5. the console ----------
{
  const pages = src("web/src/features/records/record-pages.tsx");
  assert.match(pages, /\{ id: 'linked', key: LINKED_COL, op: 'true' as const \}/, "?linked= is a rule over the hidden column of stored keys");
  assert.match(pages, /\.includes\(linked\.key\), render: \(\) => null \}\]/, "which matches a key exactly (one of a list's), never a title or a part of a key");
  assert.match(pages, /if \(type === 'boolean' && \(v == null \|\| v === ''\)\) return false;/, "a flag never set is No (sorted and filtered as off)");
  assert.match(pages, /f\?\.type === 'person' && titles/, "a person cell by name");
  assert.match(src("src/record-areas.ts"), /A former member/, "the server names the people (someone gone reads A former member)");
  assert.match(pages, /const deleted = \(\) => \{ closeRecordPanel\(\); void reload\(\); \};/, "deleted from its panel: the panel closes and the list reads again, on this page");
  assert.equal((pages.match(/onDeleted=\{deleted\}/g) ?? []).length, 3, "for each panel body the list draws");
  assert.match(src("web/src/features/records/detail-page.tsx"), /\.\.\.\(onDeleted \? \{ deleted: onDeleted \} : \{\}\)/, "the laid-out record takes it (never the area's own list elsewhere)");
  assert.match(pages, /sidePanel=\{relatedPanel\}/, "a related record opens in the list's panel");
  const page = src("web/src/features/records/detail-page.tsx");
  assert.equal((page.match(/onClick=\{opener\(r\)\}/g) ?? []).length, 3, "every related row's title opens it there (the table, the phone list, the Used by rows)");
  assert.match(page, /e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey/, "a new tab still opens its page");
  assert.match(page, /data-related-rows=''/, "Used by lists its records, not only their count");
  assert.match(page, /RECORD_TAB_STRIP_CLASS = '[^']*gap-x-4/, "the tab strip's gaps leave room for eight tabs");
  const actions = src("web/src/features/records/page-actions.tsx");
  assert.match(actions, /toast\.success\(`Moved to \$\{m\?\.state \?\? /, "a move's toast names the state it is in now");
  assert.match(src("src/record-page-routes.ts"), /return \{ to, label, state: stateWords\(area, to\), disabled \};/, "each move carries its state in words");
  assert.match(src("web/src/features/admin/ui.tsx"), /\/\^cancel\\b\/i\.test\(confirmLabel \?\? ''\) \? 'Keep it' : 'Cancel'/, "Cancel build's dialog: Keep it and Cancel build, never two Cancels");
  const creds = src("web/src/features/credentials/credentials-tab.tsx");
  assert.match(creds, /!credentialsTabParts\.vault \? Promise\.resolve\(NO_VAULT\)/, "Settings › Credentials asks the vault only when this build mounts it");
  assert.match(creds, /credentialsTabParts\.oauth \? oauthCall/, "OAuth connections likewise");
  assert.match(src("web/src/features/settings/settings-page.tsx"), /t\.kind !== 'credentials' \|\| github\.data === true/, "a tab whose only part is GitHub shows once it is set up");
  const gen = src("scripts/gen-packs.mjs");
  assert.match(gen, /export const credentialsTabParts = /, "gen-packs says which parts are mounted");
  assert.match(src("web/src/config/pack-nav.generated.ts"), /export const credentialsTabParts = \{\s*"vault": false,\s*"oauth": false,\s*"github": false,\s*"runners": false\s*\};/, "none with zero packs");
  const billing = src("web/src/features/portal/billing.tsx");
  assert.match(billing, /detailTitle=\{\(r\) => \(r\.kind === 'invite' \? r\.x\.email : r\.m\.name \|\| r\.m\.email \|\| ''\)\}/, "a person's panel is titled with their name");
  assert.match(billing, /label: 'Remove person'[^\n]*'team'\)/, "an owner may remove a person");
  assert.match(billing, /`\/team\/members\/\$\{encodeURIComponent\(removing\.id\)\}\/remove`/, "through the account's own remove route");
  assert.match(billing, /by: 'Your plan', at: null/, "the plan's allowance says the plan set it, never the app's name");
  assert.match(src("web/src/features/portal/role.tsx"), /cloneElement\(children, \{ disabled: true, title: why\(need\)/, "a disabled button's own tooltip is the reason");
  assert.match(src("web/src/features/settings/alerts-tab.tsx"), /counted\(dues, 'due date'\)/, "each Alerts count with its number, one or many");
  assert.match(gen, /"As soon as it is overdue"/, "an escalation at once reads so, never 0m overdue");
  const connect = src("web/src/features/tabs/connect.tsx");
  assert.match(connect, /expiring: 'its key expires soon'/, "Needs attention says why");
  assert.match(connect, /description=\{disconnectWords\(confirm\.confirm\)\}/, "Disconnect's body without the delete's own question");
  assert.match(pages, /<RecordDetailBody key=\{`\$\{r\.key\}:\$\{r\.connect && 'connections' in r\.connect/, "a service's panel reads again when its accounts change (its counts stay true)");
  assert.match(src("web/src/features/tabs/tab-action.tsx"), /Fill in \$\{missing\.length > 1/, "Add says what is still needed");
  assert.match(src("web/src/features/records/history-section.tsx"), /`changed \$\{changedWords\(area, fields\)\}`/, "a history line names the fields it changed");
  assert.match(src("web/src/features/teams/teams-tab.tsx"), /render: \(t\) => <span className='font-medium' data-team-link/, "a team's row opens its panel (no link in the row)");
  assert.match(src("web/src/hooks/use-breadcrumbs.tsx"), /leaf && AGENT_PAGE\.test\(pathname\) && parents\.length/, "a session started from a record crumbs through it");
  ok("the console: linked lists, flags, people, delete, related rows, Used by, toasts, dialogs, credentials, people, alerts, connections, forms, history, teams, sessions");
}
