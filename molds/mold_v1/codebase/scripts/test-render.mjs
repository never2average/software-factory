/**
 * Fallback-path test for the deterministic HTML report renderers
 * (agent/lib/render-html.ts). Runs with NO database URL, so the system of record
 * is the in-memory fallback, seeded from the test fixture — no Postgres
 * connection is ever attempted. Output is pinned to a known `now`, exercising the
 * pure (store, now) -> HTML contract.
 *
 * Usage:
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-render.mjs
 */
import assert from "node:assert/strict";

// Force the fallback path: no DB URL.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

// Seed the in-memory store. These assertions target a customer that used to
// live in data/customers.json until c7b929c emptied it; the fixture now
// belongs to the tests, not to shipped product data.
const { seedFixtureStore } = await import("./lib/test-fixture.mjs");
const seededIds = await seedFixtureStore();

const { getDb } = await import("../agent/lib/db/index.ts");
const { renderAccountReport, renderDataroomSummary, escapeHtml } = await import(
  "../agent/lib/render-html.ts"
);

assert.equal(getDb(), null, "no DB URL is set, getDb() must return null (fallback path)");

const NOW = "2026-07-10T12:00:00Z";

/* -------------------------------------------------------------------------- */
/* escapeHtml: full escaping, no raw angle brackets survive                    */
/* -------------------------------------------------------------------------- */

const escaped = escapeHtml('<script>alert("x")</script>');
assert.ok(!escaped.includes("<"), "escapeHtml removes all '<'");
assert.ok(!escaped.includes(">"), "escapeHtml removes all '>'");
assert.ok(escaped.includes("&lt;script&gt;"), "escapeHtml encodes the script tag");
assert.ok(escaped.includes("&quot;"), "escapeHtml encodes double quotes");

/* -------------------------------------------------------------------------- */
/* renderAccountReport({ customerId: "acme-bank" })                            */
/* -------------------------------------------------------------------------- */

const report = await renderAccountReport({ customerId: "acme-bank", now: NOW });

assert.ok(report.toLowerCase().startsWith("<!doctype html>"), "report is a complete HTML document");
assert.ok(report.includes("</html>"), "report closes the html element");
assert.ok(!report.includes("<script"), "report contains NO script tag (zero JS)");

assert.ok(report.includes("Acme Bank"), "report names the customer");
assert.ok(report.includes("TCK-1001"), "report lists the overdue ticket");
assert.ok(report.includes("priyesh@example.com"), "report surfaces the account owner");

// "Deliveries": the default profile's word for the first record area (profiles/00-default.json).
for (const heading of ["Open Follow-Ups", "Recent Interactions", "Deliveries", "Platform"]) {
  assert.ok(report.includes(heading), `report has the '${heading}' section`);
}

// Seed facts: health score 92, deployment + interaction present.
assert.ok(report.includes("92"), "report shows the health score");
assert.ok(report.includes("DEP-ACME-PROD"), "report lists the deployment");
assert.ok(report.includes("2026-07-03"), "report shows the interaction day");

// Signoff-relevant release status is carried through.
assert.ok(
  report.includes("pending-approval") || report.includes("deployed"),
  "report surfaces the deployment release status",
);

/* -------------------------------------------------------------------------- */
/* Unknown customer rejects                                                    */
/* -------------------------------------------------------------------------- */

await assert.rejects(
  () => renderAccountReport({ customerId: "does-not-exist", now: NOW }),
  /Unknown account: does-not-exist/,
  "an unknown id rejects with a self-describing error, in the profile's word for the account",
);

/* -------------------------------------------------------------------------- */
/* Determinism: two consecutive renders are byte-identical                     */
/* -------------------------------------------------------------------------- */

assert.equal(
  await renderAccountReport({ customerId: "acme-bank", now: NOW }),
  report,
  "renderAccountReport is a pure function of (store, now)",
);

/* -------------------------------------------------------------------------- */
/* renderDataroomSummary()                                                     */
/* -------------------------------------------------------------------------- */

const summary = await renderDataroomSummary({ now: NOW });

assert.ok(summary.toLowerCase().startsWith("<!doctype html>"), "summary is a complete HTML document");
assert.ok(summary.includes("</html>"), "summary closes the html element");
assert.ok(!summary.includes("<script"), "summary contains NO script tag");
assert.ok(summary.includes("Acme Bank"), "summary includes the first customer");
assert.ok(summary.includes("Northwind Capital"), "summary includes the second customer");

/* -------------------------------------------------------------------------- */
/* Every label speaks the deployment profile's words                           */
/* -------------------------------------------------------------------------- */

// The base product's words, read from the default profile rather than written here (the role word is counted by
// check:neutral-names): the member, and the owner heading as the report has always titled it.
const { readFileSync } = await import("node:fs");
const { createHash } = await import("node:crypto");
const BASE_VOCAB = JSON.parse(readFileSync(new URL("../profiles/00-default.json", import.meta.url), "utf8")).vocabulary;
const BASE_OWNER_HEADING = BASE_VOCAB.owner.replace(/\bowner\b/, "Owner");
/** The base product's record and role words, as whole tokens (camelCase humps and `-`/`_` are boundaries). */
const BASE_WORDS = new Set(["customer", "customers", "deployment", "deployments", "implementation", "implementations", "rollout", "rollouts", BASE_VOCAB.member.singular.toLowerCase(), BASE_VOCAB.member.plural.toLowerCase()]);
const baseWords = (t) => [...String(t).matchAll(/[A-Za-z0-9]+/g)].flatMap((m) => m[0].split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)).filter((p) => BASE_WORDS.has(p.toLowerCase()));
/** The text of a report's LABELS: headings, column heads, meta keys, the sub line, empty states, totals, title. Data
 *  (names, ids, ticket text, enum values in cells) is printed as stored and is not a label. */
const labels = (html) =>
  [...html.matchAll(/<(title|h2|th|p class="(?:sub|empty|totals)"|span class="k")>([\s\S]*?)<\/(?:title|h2|th|p|span)>/g)]
    .map((m) => m[2].replace(/<[^>]+>/g, " "))
    .concat(/Summary<\/h1>/.test(html) ? [html.match(/<h1>([^<]*)<\/h1>/)[1]] : []);

// The renderer is unchanged: under the default profile with its LEGACY words put back (what the default profile said
// before it spoke neutrally: the member's, agent/lib/legacy-member.ts, and the record words,
// scripts/fixtures/legacy-record-words), every report is byte-identical to the renderer before any label came from
// the profile (sha256 of its output on this fixture store at NOW, taken from the pre-change code at aaec6b9). The
// default profile's output differs from that in its words alone: the owner label and the record words.
const sha = (s) => createHash("sha256").update(s).digest("hex");
const { LEGACY_MEMBER } = await import("../agent/lib/legacy-member.ts");
const { spawnSync: spawnDefault } = await import("node:child_process");
const printedDefault = spawnDefault(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
assert.equal(printedDefault.status, 0, printedDefault.stderr);
const { legacyRecordProfile } = await import("./lib/legacy-record-profile.mjs");
const legacyRecords = legacyRecordProfile();
const legacyWords = { ...legacyRecords, vocabulary: { ...legacyRecords.vocabulary, member: { singular: LEGACY_MEMBER.singular, plural: LEGACY_MEMBER.plural }, owner: LEGACY_MEMBER.owner } };
const LEGACY_OWNER_HEADING = LEGACY_MEMBER.owner.replace(/\bowner\b/, "Owner");
const legacyReport = await renderAccountReport({ customerId: "acme-bank", now: NOW, profile: legacyWords });
const legacyNorthwind = await renderAccountReport({ customerId: "northwind-cap", now: NOW, profile: legacyWords });
const legacySummary = await renderDataroomSummary({ now: NOW, profile: legacyWords });
assert.equal(sha(legacyReport), "192658e7cace6094f1d968b9ab4b3c5d05a3745c0c305dd9a96114c7612cd93f", "legacy words: the account report is byte-identical to the pre-change renderer");
assert.equal(sha(legacyNorthwind), "47e28d0e4b10a46da54511a6496360b221f9ecf08736c80af123084d693c6c67", "legacy words: a second account report is byte-identical to the pre-change renderer");
assert.equal(sha(legacySummary), "d28cee03efd509a9889e0a08dabf17729ef58534fb50efc73cde25b3c9141d41", "legacy words: the data-room summary is byte-identical to the pre-change renderer");
const northwind = await renderAccountReport({ customerId: "northwind-cap", now: NOW });
// The default profile against the legacy record words alone (member and owner as the default has them): the two
// differ in LABELS only, and every label that differs is a record word swapped for the default profile's.
const recordsOnly = [
  await renderAccountReport({ customerId: "acme-bank", now: NOW, profile: legacyRecords }),
  await renderAccountReport({ customerId: "northwind-cap", now: NOW, profile: legacyRecords }),
  await renderDataroomSummary({ now: NOW, profile: legacyRecords }),
];
const swapOwner = (html) => html.split(LEGACY_OWNER_HEADING).join(BASE_OWNER_HEADING);
assert.equal(recordsOnly[0], swapOwner(legacyReport), "legacy record words: the account report differs from before only in the owner label");
assert.equal(recordsOnly[1], swapOwner(legacyNorthwind), "legacy record words: a second account report differs from before only in the owner label");
assert.equal(recordsOnly[2], swapOwner(legacySummary), "legacy record words: the data-room summary differs from before only in the owner label");
// ("Deployment Model" is the platform's software install: once the record area is named something else it reads "Hosting Model".)
const NEUTRAL = [["Deployment Model", "Hosting Model"], ["Customers", "Accounts"], ["customers", "accounts"], ["Customer", "Account"], ["customer", "account"], ["Deployments", "Deliveries"], ["deployments", "deliveries"], ["Deployment", "Delivery"], ["deployment", "delivery"]];
const neutralLabel = (label) => NEUTRAL.reduce((t, [from, to]) => t.split(from).join(to), label);
for (const [now, before, what] of [[report, recordsOnly[0], "the account report"], [northwind, recordsOnly[1], "a second account report"], [summary, recordsOnly[2], "the data-room summary"]]) {
  assert.deepEqual(labels(now), labels(before).map(neutralLabel), `default profile: ${what}'s labels are the legacy ones with each record word swapped for the profile's`);
  assert.deepEqual(baseWords(labels(now).join("\n")).filter((w) => !/^member/i.test(w)), [], `default profile: no label of ${what} carries a record word`);
  assert.ok(baseWords(labels(before).join("\n")).length > 0, `legacy record words: ${what}'s labels do carry them (the check above is not vacuous)`);
}
assert.equal(BASE_OWNER_HEADING, "Account Owner");
assert.ok(report.includes(`<span class="k">${BASE_OWNER_HEADING}</span>`), "default profile: the report's owner label is the profile's");
assert.ok(summary.includes(`<th>${BASE_OWNER_HEADING}</th>`), "default profile: the summary's owner column is the profile's");
const legacyRole = new RegExp(`\\b(${LEGACY_MEMBER.singular}|${LEGACY_MEMBER.plural})\\b`);
for (const html of [report, northwind, summary]) assert.doesNotMatch(labels(html).join("\n"), legacyRole, "default profile: no label carries the legacy member word");

// A relabelled profile (the hfc-research pack's, scripts/fixtures/agent-vocabulary/50-relabelled.json), merged by
// the real generator, shows a person none of the base product's words in either report.
const { spawnSync } = await import("node:child_process");
const { cpSync, mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const REPO = new URL("..", import.meta.url).pathname;
function mergedProfile(extra) {
  const dir = mkdtempSync(join(tmpdir(), "render-profiles-"));
  try {
    cpSync(join(REPO, "profiles/00-default.json"), join(dir, "00-default.json"));
    cpSync(join(REPO, "scripts/fixtures/agent-vocabulary/50-relabelled.json"), join(dir, "50-relabelled.json"));
    const r = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: REPO, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return extra ? extra(JSON.parse(r.stdout)) : JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const relabelled = mergedProfile();
const relabelledReports = [
  await renderAccountReport({ customerId: "acme-bank", now: NOW, profile: relabelled }),
  await renderAccountReport({ customerId: "northwind-cap", now: NOW, profile: relabelled }),
];
const relabelledSummary = await renderDataroomSummary({ now: NOW, profile: relabelled });
for (const html of relabelledReports) {
  assert.ok(labels(html).length >= 20, "the label extractor sees the report's labels");
  assert.deepEqual(baseWords(labels(html).join("\n")), [], "relabelled profile: no label of the account report carries a base word");
}
// The summary carries no stored free text: the whole document, data included, is free of them.
assert.deepEqual(baseWords(relabelledSummary), [], "relabelled profile: the data-room summary carries no base word anywhere");
const [relabelledReport] = relabelledReports;
assert.ok(relabelledReport.includes('<span class="k">Covering Analyst</span>'), "relabelled profile: the owner label is the profile's owner word");
assert.ok(relabelledReport.includes("<h2>Coverage Reports</h2>"), "relabelled profile: the deployment section is the profile's record area");
assert.ok(relabelledReport.includes("<th>Coverage Report</th><th>Environment</th><th>Period / Basis</th><th>Status</th><th>Data Quality</th>"), "relabelled profile: the deployment columns are the profile's field labels");
assert.ok(!relabelledReport.includes("Platform Summary"), "relabelled profile: the Platform area it hides is left out");
assert.ok(relabelledSummary.includes("<h1>Research Room Summary</h1>"), "relabelled profile: the summary is titled with the profile's room");
assert.ok(relabelledSummary.includes("<p class=\"sub\">All companies · "), "relabelled profile: the summary's sub line names the profile's accounts");
assert.ok(relabelledSummary.includes("<h2>Companies</h2>") && relabelledSummary.includes("<th>Company</th>"), "relabelled profile: the summary's section and column name the profile's accounts");
assert.ok(relabelledSummary.includes("<th>Covering Analyst</th>"), "relabelled profile: the owner column is the profile's owner word");
assert.match(relabelledSummary, /<p class="totals">2 companies · /, "relabelled profile: the totals line counts the profile's accounts");

// Empty states and the words behind them.
const { ownerHeading, reportWords } = await import("../agent/lib/render-html.ts");
const w = reportWords(relabelled);
assert.equal(w.deployments, "coverage reports", "relabelled profile: \"No coverage reports on record.\"");
assert.deepEqual(baseWords(Object.values(w).filter((x) => typeof x === "string").join("\n")), [], "relabelled profile: no report word is a base word");
// A profile that renames the deployment area but shows Platform calls the install's model what it is.
const withPlatform = reportWords(mergedProfile((p) => ({ ...p, dataroom: { ...p.dataroom, domains: { ...p.dataroom.domains, Platform: { label: "Platform", visible: true } } } })));
assert.equal(withPlatform.platform, true);
assert.equal(withPlatform.deploymentModel, "Hosting Model", "deployment area renamed: the platform's deployment model is its hosting model");

// A profile that renames the member but kept the LEGACY owner label (an older pack's) still reads its own member word.
const memberOnly = mergedProfile((p) => ({ ...p, vocabulary: { ...p.vocabulary, owner: LEGACY_MEMBER.owner } }));
assert.equal(ownerHeading(memberOnly), "Analyst Owner", "member renamed, legacy owner label kept: the member word is spoken");
// The default owner label names no role at all, so a profile that keeps it reads it as it is.
assert.equal(ownerHeading(mergedProfile((p) => ({ ...p, vocabulary: { ...p.vocabulary, owner: BASE_VOCAB.owner } }))), "Account Owner");
assert.equal(ownerHeading(), BASE_OWNER_HEADING, "default profile: the heading is the base one");

console.log("test-render: all assertions passed (fallback path, no Postgres).");
