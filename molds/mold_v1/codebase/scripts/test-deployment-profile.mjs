/**
 * Tests for the deployment profile (profiles/*.json -> lib/deployment-profile.generated.ts) and the per-turn
 * briefing the model reads (agent/lib/deployment-briefing.ts).
 *
 * The property that matters: with only profiles/00-default.json the product reads exactly as it did before
 * profiles existed (same copy, no extra prompt block), and a deployment that changes the profile gets its
 * own words while every IDENTIFIER (`list_customers`, `Customers/`) stays put.
 *
 * Runs offline with plain node + assert — no database, no network. Expects the generated files to be built
 * from the default profile alone (npm run build:deployment-profile).
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-deployment-profile.mjs
 */
import assert from "node:assert/strict";

const { DEPLOYMENT_PROFILE, PRODUCT_NAME, fillProfileText } = await import("../lib/deployment-profile.generated.ts");
const agentSide = await import("../agent/lib/deployment-profile.generated.ts");
const { renderDeploymentBriefing } = await import("../agent/lib/deployment-briefing.ts");

// --- the default profile reproduces today's product -------------------------

assert.equal(PRODUCT_NAME, "Delivered");
assert.equal(fillProfileText("{product}"), "Delivered", "{product} fills with the product name");
assert.equal(fillProfileText(DEPLOYMENT_PROFILE.chat.hero_lines[0]), PRODUCT_NAME, "the hero opens on the product name");
assert.deepEqual(agentSide.DEPLOYMENT_PROFILE, DEPLOYMENT_PROFILE, "web and agent read the same profile");

const cards = DEPLOYMENT_PROFILE.chat.starter_cards;
assert.equal(fillProfileText(cards.tickets_waiting, { count: 3 }), "3 open tickets are waiting on us.");
assert.equal(
  fillProfileText(cards.triage_prompt, { name: "Acme" }),
  "Triage the open tickets for Acme: what is blocking each one, who owns it, and what should we do next?",
);
assert.equal(
  fillProfileText(cards.quiet_prompt, { name: "Acme", days: 21 }),
  "Acme has been quiet for 21 days. Summarise where we left off and draft a check-in to their main contact.",
);
assert.equal(fillProfileText(cards.quiet_badge, { days: 21 }), "21d quiet");
assert.equal(
  fillProfileText(DEPLOYMENT_PROFILE.chat.account_search.pill_active, {
    context: DEPLOYMENT_PROFILE.vocabulary.account_context,
    names: "Acme, Globex",
  }),
  "Customer context: Acme, Globex — click to change",
);
assert.equal(fillProfileText("{unknown} stays"), "{unknown} stays", "an unknown slot is left as written");
assert.deepEqual(DEPLOYMENT_PROFILE.chat.user_messages, { collapse: true, collapsed_lines: 6 }, "long sent messages fold to six lines by default");
for (const d of Object.values(DEPLOYMENT_PROFILE.dataroom.domains)) assert.equal(d.visible, true, "every domain is visible by default");

// --- the briefing: nothing for the default, a reading rule for anything else ---

assert.equal(renderDeploymentBriefing(), null, "the default deployment adds nothing to the prompt");
assert.equal(renderDeploymentBriefing(DEPLOYMENT_PROFILE), null);

const research = structuredClone(DEPLOYMENT_PROFILE);
research.vocabulary.account = { singular: "company", plural: "companies" };
research.vocabulary.member = { singular: "analyst", plural: "analysts" };
research.vocabulary.owner = "lead analyst";
research.dataroom.domains.Tickets.visible = false;
research.dataroom.domains.Customers.label = "Companies";
research.agent.briefing = "This workspace researches housing finance companies.";

const block = renderDeploymentBriefing(research);
assert.ok(block, "a changed profile renders a block");
assert.ok(block.startsWith("## This deployment"));
for (const word of ["company", "companies", "analyst", "analysts", "lead analyst", "Tickets", "Companies", "housing finance"]) {
  assert.ok(block.includes(word), `briefing mentions "${word}"`);
}
// Vocabulary is a reading rule: the identifiers are named so the model maps words, not renames things.
assert.ok(block.includes("`list_customers`"), "tool identifier is kept");
assert.ok(block.includes("`Customers/`"), "data-room path token is kept");
assert.equal(renderDeploymentBriefing(DEPLOYMENT_PROFILE), null, "rendering another profile does not touch the default");

// A briefing alone is enough to render a block.
const briefed = structuredClone(DEPLOYMENT_PROFILE);
briefed.agent.briefing = "Only the briefing.";
assert.equal(renderDeploymentBriefing(briefed), "## This deployment\n\nOnly the briefing.");

// --- domains: the two record areas a deployment may redefine ---------------------------------------------------

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { DEFAULT_DOMAINS, DOMAIN_FIELDS } = await import("../lib/deployment-profile.generated.ts");
const { domainView, groupRows, groupSlug, groupTitle, lowerFirst, withProfileFields } = await import("../lib/profile-domains.ts");
const { renderDomainBriefing } = await import("../agent/lib/deployment-briefing.ts");
const ROOT = new URL("..", import.meta.url).pathname;
const GEN = join(ROOT, "scripts/gen-deployment-profile.mjs");

// The default profile IS the default: nothing is redefined, and every spot gets its old literal back.
assert.deepEqual(DEPLOYMENT_PROFILE.domains, DEFAULT_DOMAINS);
const dep = domainView("deployments");
const imp = domainView("implementations");
assert.equal(dep.redefined, false);
assert.equal(imp.redefined, false);
assert.deepEqual([dep.title, dep.singular, dep.noun, dep.nouns], ["Deployments", "Deployment", "deployment", "deployments"]);
assert.deepEqual([imp.title, imp.singular, imp.noun, imp.nouns], ["Implementations", "Implementation", "implementation", "implementations"]);
assert.equal(dep.description, "Deployments, filtered by owner.");
assert.equal(imp.description, "Rollouts, filtered by owner.");
assert.equal(dep.idLabel, "Deployment id");
assert.equal(dep.placeholder("deploymentId", "x"), "DEP-…");
assert.equal(dep.placeholder("region"), "ap-south-1");
// The old UI used three words for one field; each spot keeps its own until the profile speaks.
assert.equal(dep.label("releaseStatus", "Release status"), "Release status");
assert.equal(dep.label("releaseStatus", "Release", "short"), "Release");
assert.equal(dep.label("releaseStatus", "Status", "short"), "Status");
assert.equal(dep.label("environment", "Env", "short"), "Env");
assert.equal(imp.label("targetGoLiveDate", "Go-live", "short"), "Go-live");
assert.equal(imp.label("launchScopeSolutionIds", "Solution"), "Solution");
for (const [key, label] of Object.entries({ environment: "Environment", region: "Region", deployedVersion: "Version", releaseStatus: "Release status", healthStatus: "Health", deployOwnerEmail: "Owner" })) {
  assert.equal(DEPLOYMENT_PROFILE.domains.deployments.fields[key].label, label, `default label of ${key}`);
}
for (const [key, label] of Object.entries({ implementationStage: "Stage", implementationRiskLevel: "Risk", implementationOwnerEmail: "Owner" })) {
  assert.equal(DEPLOYMENT_PROFILE.domains.implementations.fields[key].label, label, `default label of ${key}`);
}
assert.deepEqual(DEPLOYMENT_PROFILE.domains.deployments.fields.releaseStatus.options, { deployed: "Deployed", "in-progress": "In progress", "pending-approval": "Pending approval", "rolled-back": "Rolled back", failed: "Failed" });
assert.deepEqual(Object.keys(DEPLOYMENT_PROFILE.domains.implementations.fields.implementationStage.options), DOMAIN_FIELDS.implementations.implementationStage.values, "every stage, in schema order, labelled as itself");
// Values render as they did (raw in a table cell), the old option lists are offered unchanged, nothing is hidden or fixed.
assert.equal(dep.display("releaseStatus", "deployed"), "deployed");
assert.equal(dep.display("healthStatus", "healthy", ""), "");
const legacyEnv = [{ value: "production", label: "Production" }];
assert.deepEqual(dep.options("environment", legacyEnv), legacyEnv);
assert.deepEqual(dep.options("healthStatus", [{ value: "healthy", label: "Healthy" }]), [{ value: "healthy", label: "Healthy" }]);
assert.deepEqual(dep.fixedValues(), {});
assert.equal(dep.hidden("region"), false);
assert.equal(imp.groupBy, null);
assert.deepEqual(withProfileFields(dep, [{ key: "region" }, { key: "environment" }], []), [{ key: "region" }, { key: "environment" }]);
assert.deepEqual(renderDomainBriefing("deployments", DEPLOYMENT_PROFILE.domains), []);

// The field list the generator read from source is the real one.
const schemaSrc = readFileSync(join(ROOT, "agent/lib/customer-schema.ts"), "utf8");
for (const [area, name] of [["deployments", "deploymentSchema"], ["implementations", "implementationSchema"]]) {
  const block = schemaSrc.slice(schemaSrc.indexOf(`export const ${name} = z.object({`)).split("\n});")[0];
  const keys = [...block.matchAll(/^  ([A-Za-z0-9_]+): /gm)].map((m) => m[1]);
  assert.ok(keys.length > 40, `${name} parsed`);
  for (const k of keys) assert.ok(DOMAIN_FIELDS[area][k], `${area}.${k} is a known field`);
}
assert.deepEqual(DOMAIN_FIELDS.deployments.healthStatus.values, ["healthy", "degraded", "down", "unknown"]);
assert.equal(DOMAIN_FIELDS.deployments.region.required, true);
assert.equal(DOMAIN_FIELDS.deployments.notes.column, true, "a column the zod schema does not list is still a field");

// --- the example profile (docs/examples/profile-equity-research.json) validates, and reads as research ---

function generate(overlay) {
  const dir = mkdtempSync(join(tmpdir(), "profile-test-"));
  try {
    copyFileSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    writeFileSync(join(dir, "50-probe.json"), typeof overlay === "string" ? overlay : JSON.stringify(overlay));
    return spawnSync(process.execPath, [GEN, "--print"], { env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const built = generate(readFileSync(join(ROOT, "docs/examples/profile-equity-research.json"), "utf8"));
assert.equal(built.status, 0, `the example profile validates: ${built.stderr}`);
const example = JSON.parse(built.stdout);
assert.deepEqual(example.dataroom.domains.Deployments, { label: "Coverage reports", visible: true, description: example.dataroom.domains.Deployments.description });
assert.equal(example.dataroom.domains.Implementation.label, "Portfolios");
assert.equal(example.dataroom.domains.Implementation.visible, true);
for (const d of ["Platform", "Solutions", "Tickets"]) assert.equal(example.dataroom.domains[d].visible, false, `${d} stays hidden`);

const reports = domainView("deployments", example.domains);
const portfolios = domainView("implementations", example.domains);
assert.equal(reports.redefined, true);
assert.deepEqual([reports.title, reports.noun, reports.nouns, reports.idLabel], ["Coverage reports", "coverage report", "coverage reports", "Report id"]);
assert.deepEqual([portfolios.title, portfolios.noun, portfolios.groupBy], ["Portfolios", "portfolio entry", "rolloutId"]);
assert.equal(reports.label("releaseStatus", "Release", "short"), "Status");
assert.equal(reports.label("deployedVersion", "Version"), "Period / basis");
assert.equal(reports.label("healthStatus", "Health"), "Data quality");
assert.equal(portfolios.label("dataReadinessPct", "x"), "Filings completeness");
assert.equal(portfolios.label("integrationReadinessPct", "x"), "Presentations & concalls completeness");
assert.equal(portfolios.label("evalAcceptanceStatus", "x"), "Reviewer sign-off");
// display <-> value round-trips for every relabelled enum value, and the VALUE is what a form carries.
for (const [view, key] of [[reports, "releaseStatus"], [reports, "healthStatus"], [portfolios, "implementationStage"], [portfolios, "blockerOwner"]]) {
  const options = view.options(key);
  assert.deepEqual(options.map((o) => o.value), Object.keys(view.spec.fields[key].options));
  for (const { value, label } of options) {
    assert.ok(DOMAIN_FIELDS[view.area][key].values.includes(value), `${key}: ${value} is a real enum value`);
    assert.equal(view.display(key, value), label);
    assert.equal(view.valueOf(key, label), value, `"${label}" maps back to ${value}`);
    assert.equal(view.valueOf(key, label.toUpperCase()), value, "case-insensitively");
  }
}
assert.equal(reports.display("releaseStatus", "deployed"), "Published");
assert.equal(reports.display("releaseStatus", "rolled-back"), "Restated");
assert.equal(reports.display("healthStatus", "degraded"), "Partial (values carried forward)");
assert.equal(portfolios.display("implementationStage", "UAT"), "KPI table built");
assert.equal(portfolios.display("blockerOwner", "Provider"), "Us");
assert.equal(portfolios.display("blockerOwner", "Third-Party Vendor"), "Exchange / third party");
assert.equal(reports.valueOf("releaseStatus", "something else"), "something else", "unknown text is not invented into a value");
// Hidden fields leave the form; the required ones are submitted with their fixed values.
assert.deepEqual(reports.fixedValues(), { region: "ap-south-1", environment: "prod" });
const form = withProfileFields(reports, [{ key: "customerId" }, { key: "deploymentId" }, { key: "environment" }, { key: "region" }, { key: "deployedVersion" }], reports.spec.create_fields);
assert.deepEqual(form.map((f) => f.key), ["customerId", "deploymentId", "deployedVersion", "runtime", "lastDeployAt", "approvedByEmail", "notes"]);
const type = form.find((f) => f.key === "runtime");
assert.equal(type.label, "Report type");
assert.deepEqual(type.options.map((o) => o.value), ["Initiation", "Quarterly results update", "Annual report review", "Event / rating update", "Sector note"]);
assert.equal(portfolios.formField("rolloutId").kind, "group");
assert.equal(portfolios.formField("securityReviewStatus"), null, "a hidden field has no form field");
assert.equal(portfolios.formField("dataReadinessPct").kind, "number");
// Grouping: a portfolio is the rows sharing a rolloutId.
const rows = [
  { c: "hdfc", g: "large-hfcs", o: "asha@desk.in", p: 80 },
  { c: "lic-hf", g: "large-hfcs", o: "asha@desk.in", p: 40 },
  { c: "aavas", g: "affordable-housing", o: "ravi@desk.in", p: 50 },
  { c: "stray", g: null, o: null, p: null },
];
const grouped = groupRows(rows, (r) => r.g, (r) => r.o, (r) => r.p);
assert.deepEqual(grouped.map((g) => [g.title, g.owner, g.rows.length, g.averageProgress]), [["Affordable housing", "ravi@desk.in", 1, 50], ["Large hfcs", "asha@desk.in", 2, 60], ["", null, 1, null]]);
assert.equal(groupSlug("Affordable housing"), "affordable-housing");
assert.equal(groupTitle(groupSlug("Affordable housing")), "Affordable housing");
assert.equal(lowerFirst("KPI tables"), "KPI tables");

// The briefing names both areas, the display words WITH their values, what is unused, and the identifiers.
const researchBlock = renderDeploymentBriefing(example);
for (const word of ["Portfolio", "Portfolios", "Coverage report", "Coverage reports", "Report id", "Report type", "Quarterly results update", "Filings completeness"]) {
  assert.ok(researchBlock.includes(word), `briefing mentions "${word}"`);
}
for (const id of ["`get_customer`", "`upsert_customer`", "`deployments[]`", "`implementation`", "`Deployments/`", "`Implementation/`", "`deploymentId`", "`rolloutId`", "`runtime`", "`releaseStatus`", "`implementationStage`"]) {
  assert.ok(researchBlock.includes(id), `briefing keeps the identifier ${id}`);
}
assert.ok(researchBlock.includes('"Published" is deployed'), "display word -> stored value");
assert.ok(researchBlock.includes('"Restated" is rolled-back'));
assert.ok(researchBlock.includes('"KPI table built" is UAT'));
assert.ok(researchBlock.includes('"Us" is Provider'));
assert.ok(researchBlock.includes('`region`="ap-south-1"') && researchBlock.includes('`environment`="prod"'), "the model is told what to write in the hidden required fields");
assert.ok(researchBlock.includes("securityReviewStatus") && researchBlock.includes("use only the fields named above"), "unused fields: a few names, then the rule (a list of 37 names is paid for on every turn)");
assert.ok(!researchBlock.includes('"Failed" is failed'), "a display word that is the value is not repeated");
// The budget: the two areas together cost the model at most 350 words a turn for this, the largest sensible
// redefinition (the free-text agent.briefing keeps its own 400-word limit in the generator).
const domainWords = ["implementations", "deployments"].flatMap((a) => renderDomainBriefing(a, example.domains)).join("\n").trim().split(/\s+/).length;
assert.ok(domainWords <= 350, `the domains part of the per-turn block stays within 350 words (it is ${domainWords})`);
// A small redefinition names every unused field.
const small = structuredClone(DEPLOYMENT_PROFILE);
small.domains.deployments.fields.buildSha = { hidden: true };
assert.ok(renderDeploymentBriefing(small).includes("never ask about or report buildSha"));
assert.equal(renderDomainBriefing("implementations", small.domains).length, 0, "an untouched area says nothing");

// --- a bad profile fails the BUILD, with the file, the path and what is wrong ---

const bad = (overlay, pattern) => {
  const r = generate(overlay);
  assert.notEqual(r.status, 0, `should fail: ${JSON.stringify(overlay)}`);
  assert.match(r.stderr, pattern);
  assert.match(r.stderr, /^profiles\/50-probe\.json: /, "names the file");
};
bad({ domains: { deployments: { fields: { releaseStatuss: { label: "Status" } } } } }, /domains\.deployments\.fields\.releaseStatuss: unknown field key/);
bad({ domains: { deployments: { fields: { releaseStatus: { options: { published: "Published" } } } } } }, /options\."published": not a value of releaseStatus \(deployed, in-progress/);
bad({ domains: { deployments: { fields: { region: { hidden: true } } } } }, /region is required, so hiding it needs a "fixed" value/);
bad({ domains: { deployments: { fields: { region: { hidden: true, fixed: "mumbai" } } } } }, /fixed: "mumbai" is not a valid value for region/);
bad({ domains: { deployments: { fields: { region: { fixed: "ap-south-1" } } } } }, /only a hidden field takes a fixed value/);
bad({ domains: { deployments: { fields: { notes: { options: { a: "b" } } } } } }, /notes is not an enum field/);
bad({ domains: { deployments: { fields: { notes: { colour: "red" } } } } }, /fields\.notes\.colour: unknown key/);
bad({ domains: { deployments: { fields: { healthStatus: { options: { healthy: "OK", degraded: "OK" } } } } } }, /"OK" labels both healthy and degraded/);
bad({ domains: { deployments: { kind_field: "releaseChannel", kinds: ["Initiation"] } } }, /kind_field: "releaseChannel" must be a free-text column/);
bad({ domains: { deployments: { kinds: ["Initiation"] } } }, /kind_field must name the field/);
bad({ domains: { deployments: { create_fields: ["activeIncidentRefs"] } } }, /"activeIncidentRefs" is not a single-value column/);
bad({ domains: { implementations: { group_by: "implementationStage" } } }, /group_by: "implementationStage" must be a free-text column/);
bad({ domains: { deployments: { colour: "red" } } }, /domains\.deployments\.colour: unknown key/);
bad({ domains: { releases: {} } }, /domains\.releases: unknown key/);

console.log("deployment-profile: all assertions passed");
