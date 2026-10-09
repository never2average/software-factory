/**
 * Tests for the deployment profile (profiles/*.json -> lib/deployment-profile.generated.ts) and the per-turn
 * briefing the model reads (agent/lib/deployment-briefing.ts).
 *
 * The property that matters: with only profiles/00-default.json the product reads exactly as it did before
 * profiles existed (same copy, no extra prompt block), and a deployment that changes the profile gets its
 * own words while every IDENTIFIER (`list_customers`, `customer_id`) stays put.
 *
 * Runs offline with plain node + assert — no database, no network. Expects the generated files to be built
 * from the default profile alone (npm run build:deployment-profile).
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-deployment-profile.mjs
 */
import assert from "node:assert/strict";
import { BASE_PRODUCT_WORD } from "./lib/agent-cli.mjs";

const { DEPLOYMENT_PROFILE, PRODUCT_NAME, fillProfileText } = await import("../lib/deployment-profile.generated.ts");
const agentSide = await import("../agent/lib/deployment-profile.generated.ts");
const { renderDeploymentBriefing } = await import("../agent/lib/deployment-briefing.ts");
const { FOLDER } = await import("../agent/lib/dataroom-folders.ts");

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
  "Account context: Acme, Globex — click to change",
);
assert.equal(fillProfileText("{unknown} stays"), "{unknown} stays", "an unknown slot is left as written");
assert.deepEqual(DEPLOYMENT_PROFILE.chat.user_messages, { collapse: true, collapsed_lines: 6 }, "long sent messages fold to six lines by default");
for (const d of Object.values(DEPLOYMENT_PROFILE.dataroom.domains)) assert.equal(d.visible, true, "every domain is visible by default");

// --- the chat's sandbox line (mold_v1-194): the profile's words, the place spelled as people say it ---
{
  const { sandboxWaitText, ordinal, readSandboxWait, SANDBOX_LINE_ENABLED } = await import("../lib/sandbox-wait-client.ts");
  assert.equal(sandboxWaitText(3), "Waiting for a free sandbox (3rd in line)…");
  assert.equal(sandboxWaitText(2), "Waiting for a free sandbox (2nd in line)…");
  assert.equal(sandboxWaitText(1), "Waiting for a free sandbox (next in line)…");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th", "112th"]);
  assert.equal(sandboxWaitText(4, { line: "Queued for a workspace: {place} in line", next: "Your workspace is next" }), "Queued for a workspace: 4th in line", "a profile's own words");
  assert.deepEqual(readSandboxWait({ ok: true, waits: [{ position: 5, waitedS: 1 }, { position: 2, waitedS: 9 }] }), { position: 2, count: 2 }, "the place nearest the front");
  for (const odd of [null, {}, { waits: [] }, { waits: "x" }, { waits: [{ position: 0 }, { position: "2" }] }]) assert.equal(readSandboxWait(odd), null, JSON.stringify(odd));
  assert.equal(SANDBOX_LINE_ENABLED, process.env.NEXT_PUBLIC_SANDBOX_LINE === "1", "off unless the build says the agent caps its sandboxes");
}

// --- the briefing: the default's words beside their identifiers, a reading rule for anything else ---

// The default profile speaks neutral record words; the identifiers keep the stored ones. The block is the one
// place that ties them together, and it names each stored word only as code.
const DEFAULT_BLOCK = [
  "## This workspace",
  "",
  `- An **account** (plural: accounts) is a \`customer\` in the identifiers. Say "account" to people. The identifiers do not change: tools such as \`list_customers\` and \`get_customer\`, the \`customer_id\` field and the \`${FOLDER.accounts}/\` data-room folder all refer to accounts.`,
  `- A **delivery** (plural: deliveries) is a \`deployment\` in the identifiers: \`deployments[]\` on the record, files under \`${FOLDER.deliveries}/\`, TODO containerType \`deployment\`.`,
  `- A **project** (plural: projects) is an \`implementation\` in the identifiers: \`implementation\` on the record, files under \`${FOLDER.projects}/\`, TODO containerType \`implementation\`.`,
  "- A **plan** (plural: plans) is a `rollout` in the identifiers: the `rolloutId` its `implementation` rows share.",
].join("\n");
assert.equal(renderDeploymentBriefing(), DEFAULT_BLOCK, "the default deployment's block ties its record words to the identifiers");
assert.equal(renderDeploymentBriefing(DEPLOYMENT_PROFILE), DEFAULT_BLOCK);
// A profile whose words ARE the identifiers' (the record words the default carried before) needs no such line.
const { legacyRecordProfile } = await import("./lib/legacy-record-profile.mjs");
const LEGACY_RECORDS_PROFILE = legacyRecordProfile();
assert.equal(renderDeploymentBriefing(LEGACY_RECORDS_PROFILE), null, "a profile that keeps the identifiers' own words adds nothing to the prompt");

const research = structuredClone(DEPLOYMENT_PROFILE);
research.vocabulary.account = { singular: "company", plural: "companies" };
research.vocabulary.member = { singular: "analyst", plural: "analysts" };
research.vocabulary.owner = "lead analyst";
research.dataroom.domains.tickets.visible = false;
research.dataroom.domains.accounts.label = "Companies";
research.agent.briefing = "This workspace researches housing finance companies.";

const block = renderDeploymentBriefing(research);
assert.ok(block, "a changed profile renders a block");
assert.ok(block.startsWith("## This workspace"));
for (const word of ["company", "companies", "analyst", "analysts", "lead analyst", FOLDER.tickets, "Companies", "housing finance"]) {
  assert.ok(block.includes(word), `briefing mentions "${word}"`);
}
// A relabelled deployment's model is GIVEN the tools, fields and folders in its words (agent/lib/agent-vocabulary.ts),
// so the block names those and never the base product's: a second vocabulary is one the model reasons in.
assert.ok(block.includes("`list_companies`") && block.includes("`company_id`"), "the tool and field the model actually has");
assert.ok(block.includes("`Companies/`"), "the folder the model actually reads and writes");
assert.doesNotMatch(block, new RegExp(`customer|\\b${BASE_PRODUCT_WORD}`, "i"), "no base word in a relabelled deployment's block");
assert.equal(renderDeploymentBriefing(DEPLOYMENT_PROFILE), DEFAULT_BLOCK, "rendering another profile does not touch the default");

// A briefing alone is enough to render a block.
const briefed = structuredClone(LEGACY_RECORDS_PROFILE);
briefed.agent.briefing = "Only the briefing.";
assert.equal(renderDeploymentBriefing(briefed), "## This workspace\n\nOnly the briefing.");
const briefedDefault = structuredClone(DEPLOYMENT_PROFILE);
briefedDefault.agent.briefing = "Only the briefing.";
assert.equal(renderDeploymentBriefing(briefedDefault), `${DEFAULT_BLOCK}\n\nOnly the briefing.`);

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
assert.deepEqual([dep.title, dep.singular, dep.noun, dep.nouns], ["Deliveries", "Delivery", "delivery", "deliveries"]);
assert.deepEqual([imp.title, imp.singular, imp.noun, imp.nouns], ["Projects", "Project", "project", "projects"]);
assert.equal(dep.description, "Deliveries, filtered by owner.");
assert.equal(imp.description, "Plans, filtered by owner.");
assert.equal(dep.idLabel, "Delivery id");
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
  // `custom` holds the profile's OWN fields (custom_fields): a container, not a field to relabel or hide.
  assert.ok(keys.includes("custom"), `${name} carries custom`);
  assert.equal(DOMAIN_FIELDS[area].custom, undefined, `${area}.custom is not offered as a built-in field`);
  for (const k of keys.filter((x) => x !== "custom")) assert.ok(DOMAIN_FIELDS[area][k], `${area}.${k} is a known field`);
}
// The default deployment declares no fields of its own, on either area.
assert.deepEqual([dep.customFields, imp.customFields, dep.listCustomFields], [[], [], []]);
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
// A NEW deployment: it names each domain by its id and takes the default profile's stored folders.
assert.deepEqual(example.dataroom.domains.deliveries, { folder: FOLDER.deliveries, label: "Coverage reports", visible: true, description: example.dataroom.domains.deliveries.description });
assert.equal(example.dataroom.domains.projects.label, "Portfolios");
assert.equal(example.dataroom.domains.projects.visible, true);
assert.equal(example.dataroom.domains.accounts.folder, FOLDER.accounts, "relabelling a domain does not move where it is stored");
for (const d of ["platform", "solutions", "tickets"]) assert.equal(example.dataroom.domains[d].visible, false, `${d} stays hidden`);

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
// …by the names the model's tools use for them (the profile relabels every one), never the base names.
for (const id of ["`get_company`", "`upsert_company`", "`coverageReports[]`", "`portfolioEntry`", "`Coverage-reports/`", "`Portfolios/`", "`coverageReportId`", "`portfolioId`", "`runtime`", "`releaseStatus`", "`portfolioEntryStage`", "containerType `coverageReport`", "containerType `portfolioEntry`"]) {
  assert.ok(researchBlock.includes(id), `briefing names ${id}`);
}
assert.doesNotMatch(researchBlock, new RegExp(`customer|deployments?\\b|\\bimplementation|rollout|\\b${BASE_PRODUCT_WORD}`, "i"), "no base word in a relabelled deployment's block");
assert.ok(researchBlock.includes('"Published" is `deployed`'), "display word -> stored value");
assert.ok(researchBlock.includes('"Restated" is `rolled-back`'));
assert.ok(researchBlock.includes('"KPI table built" is `UAT`'));
assert.ok(researchBlock.includes('"Us" is `Provider`'));
assert.ok(researchBlock.includes('`region`="ap-south-1"') && researchBlock.includes('`environment`="prod"'), "the model is told what to write in the hidden required fields");
assert.ok(researchBlock.includes("securityReviewStatus") && researchBlock.includes("use only the fields named above"), "unused fields: a few names, then the rule (a list of 37 names is paid for on every turn)");
assert.ok(!researchBlock.includes('"Failed" is failed'), "a display word that is the value is not repeated");
// custom_fields: the model is told where they live, each key with its label, type, choices and whether it is required.
assert.deepEqual(reports.customFields.map((f) => f.key), ["rating", "target_price", "data_completeness", "publish_date", "source_link", "thesis"]);
assert.deepEqual(reports.listCustomFields.map((f) => f.key), ["rating", "target_price", "data_completeness"]);
assert.deepEqual(portfolios.customFields.map((f) => [f.key, f.type]), [["benchmark", "text"], ["next_rebalance", "date"]]);
assert.ok(researchBlock.includes("`coverageReports[].custom`") && researchBlock.includes("`portfolioEntry.custom`"), "where the custom values are written");
assert.ok(researchBlock.includes('`rating`="Rating" (Buy|Add|Hold|Reduce|Sell; required)'), "a pick list names its choices, and that it is required");
assert.ok(researchBlock.includes('`data_completeness`="Data completeness" (percent 0-100)'));
assert.ok(researchBlock.includes('`publish_date`="Publish date" (yyyy-mm-dd)') && researchBlock.includes('`source_link`="Source filing" (http(s)-link)'));
assert.ok(researchBlock.includes('`benchmark`="Benchmark" (text)'));
// Custom fields alone redefine an area enough to be briefed, and nothing else about it is said.
const onlyCustom = structuredClone(DEPLOYMENT_PROFILE);
onlyCustom.domains.deployments.custom_fields = [{ key: "inspection_date", label: "Inspection date", type: "date" }];
assert.ok(renderDeploymentBriefing(onlyCustom).includes('`inspection_date`="Inspection date" (yyyy-mm-dd)'));
assert.equal(renderDomainBriefing("implementations", onlyCustom.domains).length, 0);
// The budget: the two areas together cost the model at most 420 words a turn for this, the largest sensible
// redefinition. It was 350 before custom_fields; the example's eight own fields (key, label, type, choices) and the
// rule for writing them cost about 60 words, and the model cannot fill a field it was never told about
// (the free-text agent.briefing keeps its own 400-word limit in the generator).
const domainWords = ["implementations", "deployments"].flatMap((a) => renderDomainBriefing(a, example.domains)).join("\n").trim().split(/\s+/).length;
assert.ok(domainWords <= 420, `the domains part of the per-turn block stays within 420 words (it is ${domainWords})`);
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
// account_fields.hidden: real customerSchema keys only, never the id or the name.
bad({ account_fields: { hidden: ["arrr"] } }, /account_fields\.hidden: "arrr" is not a field of customerSchema/);
bad({ account_fields: { hidden: ["name"] } }, /account_fields\.hidden: "name" cannot be hidden/);
bad({ account_fields: { hidden: "arr" } }, /account_fields\.hidden must be a list/);
assert.equal(generate({ account_fields: { hidden: ["arr", "seats", "platform", "tickets"] } }).status, 0, "hiding real account fields generates");
// The second owner is hidden by its original key (existing profiles) or by the neutral one beside it; naming both
// keys names the one field twice.
assert.equal(generate({ account_fields: { hidden: ["aeOwner", "arr"] } }).status, 0, "aeOwner still hides the second owner");
assert.equal(generate({ account_fields: { hidden: ["secondaryOwner", "arr"] } }).status, 0, "secondaryOwner hides it too");
assert.equal(generate({ account_fields: { hidden: ["accountOwner"] } }).status, 0, "the owner's neutral key is accepted the same way");
bad({ account_fields: { hidden: ["aeOwner", "secondaryOwner"] } }, /account_fields\.hidden lists a field twice/);
bad({ account_fields: { hidden: ["secondaryOwners"] } }, /account_fields\.hidden: "secondaryOwners" is not a field of customerSchema/);
bad({ vocabulary: { secondary_owner: "" } }, /vocabulary\.secondary_owner must be a non-empty string/);
assert.equal(generate({ vocabulary: { secondary_owner: "Relationship manager" } }).status, 0, "a profile names the second owner");
bad({ domains: { deployments: { fields: { region: { hidden: true, fixed: "mumbai" } } } } }, /fixed: "mumbai" is not a valid value for region/);
bad({ domains: { deployments: { fields: { region: { fixed: "ap-south-1" } } } } }, /only a hidden field takes a fixed value/);
bad({ domains: { deployments: { fields: { notes: { options: { a: "b" } } } } } }, /notes is not an enum field/);
bad({ domains: { deployments: { fields: { notes: { colour: "red" } } } } }, /fields\.notes\.colour: unknown key/);
bad({ domains: { deployments: { fields: { healthStatus: { options: { healthy: "OK", degraded: "OK" } } } } } }, /"OK" labels both healthy and degraded/);
bad({ domains: { deployments: { kind_field: "releaseChannel", kinds: ["Initiation"] } } }, /kind_field: "releaseChannel" must be a free-text column/);
bad({ domains: { deployments: { kinds: ["Initiation"] } } }, /kind_field must name the field/);
bad({ domains: { deployments: { create_fields: ["activeIncidentRefs"] } } }, /"activeIncidentRefs" is not a single-value column/);
bad({ domains: { implementations: { group_by: "implementationStage" } } }, /group_by: "implementationStage" must be a free-text column/);
// custom_fields: every rule, as a sentence that names the entry.
const cf = (field, area = "deployments") => ({ domains: { [area]: { custom_fields: Array.isArray(field) ? field : [field] } } });
bad({ domains: { deployments: { custom_fields: { rating: {} } } } }, /custom_fields must be a list of fields/);
bad(cf({ key: "targetPrice", label: "Target price", type: "number" }), /custom_fields\[0\]\.key must be snake_case/);
bad(cf({ key: "2nd_rating", label: "x", type: "text" }), /key must be snake_case/);
bad(cf({ key: "region", label: "Region 2", type: "text" }), /"region" is already a built-in field of the deployments table/);
bad(cf({ key: "deployment_id", label: "Id", type: "text" }), /"deployment_id" is already a built-in field/);
bad(cf({ key: "custom", label: "Custom", type: "text" }), /"custom" is already a built-in field/);
bad(cf({ key: "rollout_id", label: "Id", type: "text" }, "implementations"), /already a built-in field of the implementation table/);
bad(cf([{ key: "rating", label: "Rating", type: "text" }, { key: "rating", label: "Other", type: "text" }]), /custom_fields\[1\]\.key: "rating" is declared twice/);
bad(cf([{ key: "rating", label: "Rating", type: "text" }, { key: "rating_2", label: "rating", type: "text" }]), /"rating" is also the label of "rating"/);
bad(cf({ key: "rating", type: "text" }), /custom_fields\[0\]\.label must be a non-empty string/);
bad(cf({ key: "rating", label: "Rating", type: "money" }), /"money" is not a field type\. Use one of text, long_text, number, percent, date, email, link, pick_list/);
bad(cf({ key: "rating", label: "Rating", type: "pick_list" }), /a pick_list needs a non-empty list of choices/);
bad(cf({ key: "rating", label: "Rating", type: "pick_list", options: ["Buy", "buy"] }), /lists the same choice twice/);
bad(cf({ key: "rating", label: "Rating", type: "text", options: ["Buy"] }), /only a pick_list has options/);
bad(cf({ key: "rating", label: "Rating", type: "text", required: "yes" }), /required must be true or false/);
bad(cf({ key: "rating", label: "Rating", type: "text", show_in_list: 1 }), /show_in_list must be true or false/);
bad(cf({ key: "rating", label: "Rating", type: "text", help: "" }), /help must be a non-empty string/);
bad(cf({ key: "rating", label: "Rating", type: "text", colour: "red" }), /custom_fields\[0\]\.colour: unknown key \(a custom field takes key, label, type/);
// …and a good one, on the other area, in a non-research vertical: the generator accepts it and keeps it as written.
const site = generate(cf([{ key: "inspection_date", label: "Inspection date", type: "date", required: true }, { key: "permit_link", label: "Permit", type: "link", show_in_list: true }], "implementations"));
assert.equal(site.status, 0, site.stderr);
assert.deepEqual(JSON.parse(site.stdout).domains.implementations.custom_fields.map((f) => f.key), ["inspection_date", "permit_link"]);
assert.deepEqual(JSON.parse(site.stdout).domains.deployments.custom_fields, []);

// account_fields.custom_fields: the account record's OWN fields, with the areas' spec and the same rules.
const acf = (field, hidden = []) => ({ account_fields: { hidden, custom_fields: Array.isArray(field) ? field : [field] } });
bad({ account_fields: { custom_fields: { notes: {} } } }, /account_fields\.custom_fields must be a list of fields/);
bad(acf({ key: "companyNotes", label: "Notes", type: "long_text" }), /account_fields\.custom_fields\[0\]\.key must be snake_case/);
// Never a built-in account field, in either spelling, and never one the table has but the schema does not name.
bad(acf({ key: "health_reason", label: "Why", type: "text" }), /account_fields\.custom_fields\[0\]\.key: "health_reason" is already a built-in field of the customers table/);
bad(acf({ key: "arr", label: "ARR", type: "number" }), /"arr" is already a built-in field of the customers table/);
bad(acf({ key: "customer_name", label: "Name", type: "text" }), /"customer_name" is already a built-in field/);
bad(acf({ key: "org_id", label: "Org", type: "text" }), /"org_id" is already a built-in field/);
bad(acf({ key: "custom", label: "Custom", type: "text" }), /"custom" is already a built-in field/);
bad(acf({ key: "deployments", label: "Reports", type: "text" }), /"deployments" is already a built-in field/);
bad(acf([{ key: "notes", label: "Notes", type: "long_text" }, { key: "notes", label: "More", type: "text" }]), /account_fields\.custom_fields\[1\]\.key: "notes" is declared twice/);
bad(acf([{ key: "notes", label: "Notes", type: "long_text" }, { key: "memo", label: "notes", type: "text" }]), /"notes" is also the label of "notes"/);
bad(acf({ key: "notes", label: "Notes", type: "rich_text" }), /account_fields\.custom_fields\[0\]\.type: "rich_text" is not a field type/);
bad(acf({ key: "notes", label: "Notes", type: "pick_list" }), /a pick_list needs a non-empty list of choices/);
bad(acf({ key: "notes", label: "Notes", type: "long_text", options: ["a"] }), /only a pick_list has options/);
bad(acf({ key: "notes", label: "Notes", type: "long_text", show_in_list: "no" }), /show_in_list must be true or false/);
bad(acf({ key: "notes", label: "Notes", type: "long_text", colour: "red" }), /account_fields\.custom_fields\[0\]\.colour: unknown key/);
// hidden + custom: `custom` is the container, not a field to hide; a HIDDEN built-in is still built in, so an own
// field cannot take its name; hiding built-ins and declaring own fields together is the ordinary case.
bad(acf({ key: "notes", label: "Notes", type: "long_text" }, ["custom"]), /account_fields\.hidden: "custom" cannot be hidden; it holds account_fields\.custom_fields/);
bad(acf({ key: "health_reason", label: "Why", type: "text" }, ["healthReason"]), /"health_reason" is already a built-in field of the customers table/);
const notes = generate(acf([{ key: "notes", label: "Notes", type: "long_text", help: "What we know about the company." }, { key: "rating_view", label: "House view", type: "pick_list", options: ["Positive", "Neutral", "Negative"], show_in_list: true }], ["arr", "seats", "healthReason"]));
assert.equal(notes.status, 0, notes.stderr);
assert.deepEqual(JSON.parse(notes.stdout).account_fields, { hidden: ["arr", "seats", "healthReason"], custom_fields: [{ key: "notes", label: "Notes", type: "long_text", help: "What we know about the company." }, { key: "rating_view", label: "House view", type: "pick_list", options: ["Positive", "Neutral", "Negative"], show_in_list: true }] }, "kept exactly as written");
assert.deepEqual(DEPLOYMENT_PROFILE.account_fields.custom_fields, [], "the default profile declares no account fields");

// The briefing names the account's own fields: where they live, each key with its label and type, and that the
// list tool does not carry an unlisted one (so the model reads the record for it). Nothing when none are declared.
const withNotes = structuredClone(DEPLOYMENT_PROFILE);
withNotes.account_fields.custom_fields = [{ key: "notes", label: "Notes", type: "long_text" }, { key: "house_view", label: "House view", type: "pick_list", options: ["Positive", "Negative"], show_in_list: true }];
const notesBlock = renderDeploymentBriefing(withNotes);
assert.ok(notesBlock.startsWith("## This workspace"), "own account fields alone are enough to brief");
assert.ok(notesBlock.includes("- Own fields of each account, by key in its `custom` (read with `get_customer`, write with `upsert_customer`; send only changed keys; null clears; other keys are refused; add to a long text with `custom_append` instead of resending it (replace one: null in `custom` plus the new text in `custom_append`); `list_customers` carries only `house_view`): `notes`=\"Notes\" (long_text), `house_view`=\"House view\" (Positive|Negative)."), notesBlock);
const { renderAccountFieldsBriefing } = await import("../agent/lib/deployment-briefing.ts");
assert.deepEqual(renderAccountFieldsBriefing(DEPLOYMENT_PROFILE), [], "the default says nothing about account fields");
const pickOnly = structuredClone(withNotes);
pickOnly.account_fields.custom_fields = [withNotes.account_fields.custom_fields[1]];
assert.ok(!renderDeploymentBriefing(pickOnly).includes("custom_append"), "no long text, no append to mention");

bad({ domains: { deployments: { colour: "red" } } }, /domains\.deployments\.colour: unknown key/);
bad({ domains: { releases: {} } }, /domains\.releases: unknown key/);

console.log("deployment-profile: all assertions passed");
