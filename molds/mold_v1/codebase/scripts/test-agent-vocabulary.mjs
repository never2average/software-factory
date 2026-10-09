#!/usr/bin/env node
/**
 * Behavioural tests for the agent's vocabulary (agent/lib/agent-vocabulary.ts) and what is built on it: the
 * model-facing tools (agent/lib/model-facing/tools/model-facing.ts), the root prompt (agent/lib/root-instructions.ts),
 * the memory store's two spellings, and specialists.exclude in scripts/gen-deployment-profile.mjs.
 *
 * check:agent-vocabulary proves the model READS no base word. This proves the other half: that what the model
 * WRITES in the profile's words lands in storage exactly where it always did, that a relabelled path reaches the
 * stored folder, and that the default profile is left untouched (every function the identity).
 *
 *   npm run test:agent-vocabulary
 *
 * Phase 1 runs here against a relabelling profile passed in as data. Phase 2 re-runs this file inside a throwaway
 * copy of the checkout stamped with the fixture profile (tests/fixtures under scripts/fixtures/agent-vocabulary),
 * because the agent reads its profile at module load, the way a build does.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// eve's `.js` -> `.ts` specifiers, and the web app's `@/` alias and extensionless imports (app/_components).
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) return await n(s + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);

const ROOT = process.cwd();
// The member's legacy words (agent/lib/legacy-member.ts): text stored before the default spoke neutrally, which a
// relabelling profile still translates. Read from their one spelling, never written here.
const { LEGACY_MEMBER: L } = await import(pathToFileURL(join(process.cwd(), "agent/lib/legacy-member.ts")).href);
const FIXTURE = join(new URL("..", import.meta.url).pathname, "scripts/fixtures/agent-vocabulary/50-relabelled.json");
let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message.split("\n").join("\n       ")}`);
    process.exitCode = 1;
  }
};
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

/** The merged fixture profile, validated by the real generator. */
function fixtureProfile() {
  const dir = mkdtempSync(join(tmpdir(), "vocab-profiles-"));
  cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
  cpSync(FIXTURE, join(dir, "50-relabelled.json"));
  const r = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

async function phaseUnits() {
  const v = await imp("agent/lib/agent-vocabulary.ts");
  const { DEPLOYMENT_PROFILE } = await imp("agent/lib/deployment-profile.generated.ts");
  const base = v.createVocabulary(DEPLOYMENT_PROFILE);
  const voc = v.createVocabulary(fixtureProfile(), ["app-author", "browser", "evals", "follow-ups", "research", "workflow-author", "customer-portal"]);
  // The folders each profile STORES its domains under, by id (agent/lib/dataroom-folders.ts): this build's (B) and
  // the fixture's (S), which pins the names its data room already holds. No stored name is spelled in this file.
  const B = base.stored;
  const S = voc.stored;

  console.log("The default profile changes nothing:");
  await check("nothing is relabelled", () => assert.equal(base.relabelled, false));
  await check("base text's role placeholders are filled with the default profile's neutral words", () => {
    assert.equal(v.speakWith(base, "The {member} who owns it — usually the customer's {owner}."), "The member who owns it — usually the customer's account owner.");
    assert.equal(v.speakWith(base, "Ask an {member}; the {Members} decide; {Owner} first."), "Ask a member; the Members decide; Account owner first.");
    assert.equal(v.fillWith(base, `${B.people}/{id}/identity.json and {customer_id}`), `${B.people}/{id}/identity.json and {customer_id}`, "only the role placeholders");
    assert.equal(v.hasRolePlaceholder("the {owner}"), true);
    assert.equal(v.hasRolePlaceholder(`${B.people}/{id}`), false);
  });
  await check("base text's record placeholders are filled with the default profile's neutral words", () => {
    assert.equal(
      v.speakWith(base, "List all {accounts}: a {account}'s {deployments}, its {implementation} and its {rollout}. {Account} id."),
      "List all accounts: an account's deliveries, its project and its plan. Account id.",
    );
    assert.equal(v.fillWith(base, "{Accounts}, {Deployment}, {Deployments}, {Implementation}, {Implementations}, {Rollout}, {Rollouts}, {rollouts}, {implementations}, {deployment}"),
      "Accounts, Delivery, Deliveries, Project, Projects, Plan, Plans, plans, projects, delivery");
    assert.equal(v.fillWith(base, "an {deployment} or a {implementation}; ${account} and {customer} and {customer_id} stay"), "a delivery or a project; ${account} and {customer} and {customer_id} stay");
    assert.equal(v.hasRolePlaceholder("one {account}"), true);
    assert.equal(v.wordForWith(base, "account"), "account");
    assert.equal(v.wordForWith(base, "Deployments"), "Deliveries");
  });
  await check("a folder placeholder is the folder the profile stores the domain under; a domain placeholder its label", () => {
    // The default profile: base text names no folder, it writes a placeholder, and the profile fills it.
    assert.equal(v.fillWith(base, "{folder:accounts}/{customer_id}/context.md, across {domain:accounts} and {domain:tickets}"), `${B.accounts}/{customer_id}/context.md, across ${base.labels.accounts} and ${base.labels.tickets}`);
    assert.equal(v.speakWith(base, "under {folder:deliveries}/{id}/ and {folder:uploads}/{person_id}/"), `under ${B.deliveries}/{id}/ and ${B.uploads}/{person_id}/`);
    assert.equal(v.hasRolePlaceholder("{folder:people}/{id}"), true);
    assert.equal(v.hasRolePlaceholder("{folder:nowhere}/{id}"), false, "only a real domain id is a placeholder");
    assert.equal(v.fillWith(base, "${folder:accounts} stays"), "${folder:accounts} stays");
    for (const id of Object.keys(base.labels)) assert.equal(base.labels[id], B[id], `the default label of ${id} is its folder's name: nothing to translate`);
    assert.equal(base.folders.size, 0);
    // A deployment that pins other stored names and relabels: the model addresses the label's folder form, reads
    // the label in a sentence, and what it sends back lands in the pinned folder.
    assert.equal(v.fillWith(voc, "{folder:deliveries}/acme and {domain:deliveries}"), "Coverage-reports/acme and Coverage reports");
    assert.equal(v.speakWith(voc, "Read {folder:accounts}/{id}/sla.json across {domain:accounts}"), "Read Companies/{id}/sla.json across Companies");
    assert.equal(v.toStoredPathWith(voc, "Coverage-reports/acme/x.md"), `${S.deliveries}/acme/x.md`);
    assert.notEqual(S.accounts, B.accounts, "the fixture pins a stored name that is not this build's default");
  });
  await check("a profile that pins a stored folder and gives no label reads the folder's own name: nothing is translated", async () => {
    const { foldersOf } = await imp("agent/lib/dataroom-folders.ts");
    const pinned = structuredClone(DEPLOYMENT_PROFILE);
    for (const id of Object.keys(pinned.dataroom.domains)) pinned.dataroom.domains[id] = { ...pinned.dataroom.domains[id], folder: S[id], label: S[id] };
    const pv = v.createVocabulary(pinned);
    assert.equal(pv.relabelled, false);
    assert.deepEqual(foldersOf(pinned), { ...S, uploads: B.uploads });
    assert.equal(v.speakWith(pv, "{folder:accounts}/{id}/context.md in {domain:accounts}"), `${S.accounts}/{id}/context.md in ${S.accounts}`);
    assert.equal(v.toStoredPathWith(pv, `${S.accounts}/x`), `${S.accounts}/x`);
  });
  await check("the record words' legacy spelling is a contract under the default profile: never translated", () => {
    const t = `customer_id, list_customers, ${B.accounts}/acme, deploymentId, implementationStage, rolloutId; an old note says the customer's deployment and its rollout`;
    assert.equal(v.speakWith(base, t), t);
    for (const id of ["customer_id", "list_customers", "deployments", "implementation", "rolloutId"]) assert.equal(v.speakIdentifierWith(base, id), id);
    assert.equal(base.words.size, 0);
  });
  await check("a profile that keeps the identifiers' own words is not relabelled, and its placeholders read those words", () => {
    const legacy = structuredClone(DEPLOYMENT_PROFILE);
    legacy.vocabulary.account = { singular: "customer", plural: "customers" };
    legacy.domains.deployments.label = { singular: "Deployment", plural: "Deployments" };
    legacy.domains.implementations.label = { singular: "Implementation", plural: "Implementations" };
    legacy.domains.implementations.group_label = { singular: "Rollout", plural: "Rollouts" };
    const lv = v.createVocabulary(legacy);
    assert.equal(lv.relabelled, false);
    assert.equal(v.speakWith(lv, "a {account}'s {deployments} and {rollout}; {Implementation}"), "a customer's deployments and rollout; Implementation");
  });
  await check("the build scripts' plain-JavaScript fill (scripts/lib/profile-words.mjs) is fillWith, key for key", async () => {
    const { fillPlaceholders, hasPlaceholder } = await imp("scripts/lib/profile-words.mjs");
    const fixture = fixtureProfile();
    for (const [profile, vocab] of [[DEPLOYMENT_PROFILE, base], [fixture, voc]]) {
      for (const key of [...v.PLACEHOLDER_KEYS, ...v.FOLDER_PLACEHOLDER_KEYS]) {
        for (const text of [`{${key}}`, `a {${key}} here`, `An **{${key}}** and an {${key}}'s id; \${${key}} stays`]) {
          assert.equal(fillPlaceholders(text, profile), v.fillWith(vocab, text), text);
        }
        assert.equal(hasPlaceholder(`x {${key}} y`), true);
      }
    }
    assert.equal(hasPlaceholder(`${B.people}/{id}/x and \${account}`), false);
  });
  await check("the member's legacy word is data under the default profile: not translated, not a base word", () => {
    const t = `${L.owner} reassigned; ownerTeam ${L.singular}`;
    assert.equal(v.speakWith(base, t), t);
    assert.equal(v.speakIdentifierWith(base, "fdeOwner"), "fdeOwner");
  });
  await check("speak, identifiers, paths, JSON: all the identity", () => {
    const t = `List all customers (\`customer_id\`, ${B.accounts}/acme, ${L.owner}, deploymentId).`;
    assert.equal(v.speakWith(base, t), t);
    assert.equal(v.speakIdentifierWith(base, "list_customers"), "list_customers");
    assert.equal(v.toStoredPathWith(base, `${B.accounts}/x`), `${B.accounts}/x`);
    const o = { customerId: "x" };
    assert.equal(v.outputForModelWith(base, o), o);
    assert.equal(v.inputFromModelWith(base, o, { root: undefined, keysBack: new WeakMap(), enumsBack: new WeakMap() }), o);
  });
  await check("the memory prefix stays `customer`", () => assert.equal(base.memoryPrefix, "customer"));

  console.log("\nA relabelling profile (the research-desk fixture):");
  const ids = {
    list_customers: "list_companies", get_customer: "get_company", upsert_customer: "upsert_company",
    list_stale_customers: "list_stale_companies", match_customer_by_email: "match_company_by_email",
    read_customer_slas: "read_company_slas", list_fdes: "list_analysts", list_members: "list_analysts", customer_id: "company_id",
    customerId: "companyId", fdeOwner: "analystOwner", solutionFdeOwner: "solutionAnalystOwner",
    deploymentId: "coverageReportId", deployments: "coverageReports", implementation: "portfolioEntry",
    rolloutId: "portfolioId", implementationProgressPct: "portfolioEntryProgressPct", CUSTOMER_ID: "COMPANY_ID",
    implementation_checkin: "portfolio_entry_checkin", publish_artifact: "publish_artifact",
  };
  for (const [from, to] of Object.entries(ids)) await check(`identifier ${from} -> ${to}`, () => assert.equal(v.speakIdentifierWith(voc, from), to));
  const prose = [
    ["Get the full record for one customer.", "Get the full record for one company."],
    ["an implementation and a rollout", "a portfolio entry and a portfolio"],
    [`The ${L.singular} who owns it — usually the customer's ${L.owner}.`, "The analyst who owns it — usually the company's covering analyst."],
    [`${L.owner} of record`, "Covering analyst of record"],
    // The base text's own role placeholders, filled from the profile (articles follow the word).
    ["The {member} who owns it — usually the customer's {owner}.", "The analyst who owns it — usually the company's covering analyst."],
    ["Ask a {member}; the {Members} decide; {Owner} first.", "Ask an analyst; the Analysts decide; Covering analyst first."],
    // …and its record placeholders: the profile's word for each record, never the base one.
    ["List all {accounts}: a {account}'s {deployments}. {Account} id.", "List all companies: a company's coverage reports. Company id."],
    ["an {implementation} in one {rollout}; {Deployments} and {Implementations}", "a portfolio entry in one portfolio; Coverage reports and Portfolio entries"],
    ["{Accounts} in `missing`; per-{account} filters; {account}-facing", "Companies in `missing`; per-company filters; company-facing"],
    [`Read ${S.accounts}/{id}/sla.json and ${S.projects}/{id}/x and ${S.deliveries}/{customer_id}/`, "Read Companies/{id}/sla.json and Portfolios/{id}/x and Coverage-reports/{company_id}/"],
    [`seven domains (${S.accounts}, ${S.deliveries}, ${S.projects}, ${S.people})`, "seven domains (Companies, Coverage reports, Portfolios, People)"],
    ["scope 'customer:{id}' e.g. 'customer:acme-bank'", "scope 'company:{id}' e.g. 'company:acme-bank'"],
    ["This deployment's own fields", "This workspace's own fields"],
    ["write `deployments[].custom` and `implementation.custom`", "write `coverageReports[].custom` and `portfolioEntry.custom`"],
    // A kept specialist is called by its directory name, even one carrying a relabelled word.
    ["delegate to `customer-portal` or customer-portal", "delegate to `customer-portal` or customer-portal"],
  ];
  for (const [from, to] of prose) await check(`speak: ${from}`, () => assert.equal(v.speakWith(voc, from), to));
  await check("code values: `deployment` -> coverageReport, customer-vpc -> company-vpc, prose kept prose", () => {
    assert.equal(v.speakCodeWith(voc, "deployment"), "coverageReport");
    assert.equal(v.speakCodeWith(voc, "customer-vpc"), "company-vpc");
    assert.equal(v.speakCodeWith(voc, "Waiting on Customer"), "Waiting on Company");
    assert.equal(v.speakCodeWith(voc, S.accounts), "Companies");
  });
  await check("paths: display <-> stored, stored accepted as is, free text left alone", () => {
    assert.equal(v.toDisplayPathWith(voc, `${S.deliveries}/acme/x.md`), "Coverage-reports/acme/x.md");
    assert.equal(v.toStoredPathWith(voc, "Coverage-reports/acme/x.md"), `${S.deliveries}/acme/x.md`);
    assert.equal(v.toStoredPathWith(voc, `${S.accounts}/acme/x.md`), `${S.accounts}/acme/x.md`);
    assert.equal(v.toStoredPathWith(voc, "Portfolios"), S.projects);
    const map = { root: undefined, keysBack: new WeakMap(), enumsBack: new WeakMap() };
    const roles = { paths: new Set(["prefix", "path"]) };
    assert.deepEqual(v.inputFromModelWith(voc, { note: "see Companies/acme/x.md today", name: "Portfolios" }, map, roles), { note: "see Companies/acme/x.md today", name: "Portfolios" });
    assert.deepEqual(v.inputFromModelWith(voc, { prefix: "Portfolios" }, map, roles), { prefix: S.projects });
  });
  await check("memory: both spellings are one scope, shown in the profile's", () => {
    assert.deepEqual(v.memoryScopeVariants("company:acme", voc), ["company:acme", "customer:acme"]);
    assert.deepEqual(v.memoryScopeVariants("customer:acme", voc), ["company:acme", "customer:acme"]);
    assert.deepEqual(v.memoryScopeVariants("person:sam", voc), ["person:sam"]);
    assert.equal(v.displayMemoryScope("customer:acme", voc), "company:acme");
  });
  await check("a schema round-trips: the model's input comes back as the base input", () => {
    const schema = { type: "object", properties: { customerId: { type: "string", description: "Customer slug" }, deployments: { type: "array", items: { type: "object", properties: { deploymentId: { type: "string" }, region: { enum: ["customer-vpc", "on-prem"] } }, required: ["deploymentId"] } } }, required: ["customerId"] };
    const { schema: out, map } = v.schemaForModelWith(voc, schema);
    assert.deepEqual(Object.keys(out.properties), ["companyId", "coverageReports"]);
    assert.deepEqual(out.required, ["companyId"]);
    assert.equal(out.properties.companyId.description, "Company slug");
    assert.deepEqual(out.properties.coverageReports.items.properties.region.enum, ["company-vpc", "on-prem"]);
    const back = v.inputFromModelWith(voc, { companyId: "acme", coverageReports: [{ coverageReportId: "r1", region: "company-vpc" }] }, map);
    assert.deepEqual(back, { customerId: "acme", deployments: [{ deploymentId: "r1", region: "customer-vpc" }] });
    // …and a stored record goes out the way the schema told the model.
    assert.deepEqual(v.outputForModelWith(voc, back), { companyId: "acme", coverageReports: [{ coverageReportId: "r1", region: "company-vpc" }] });
  });
  await check("results: opaque content untouched, keys and paths spoken, messages spoken", () => {
    const out = v.outputForModelWith(voc, { path: `${S.accounts}/a/x.jsonl`, records: [{ customerId: "a", note: `${S.accounts}/a` }], error: "Customer a not found" }, new Set(["records"]));
    assert.deepEqual(out, { path: "Companies/a/x.jsonl", records: [{ customerId: "a", note: `${S.accounts}/a` }], error: "Company a not found" });
  });
  await check("two parameters that would read alike are refused, not merged", () => {
    assert.throws(() => v.schemaForModelWith(voc, { type: "object", properties: { customerName: {}, companyName: {} } }), /already a parameter/);
  });
  await check("an excluded specialist leaves a prompt's lists; a kept one keeps its name", () => {
    const t = "The subagents `agent()` may name: `deployment`, `configuration`, `evals`,\n`data-migration`, `customer-context`, `follow-ups`.\n- **deployment** — deploy things.\n- **evals** — evals.";
    const out = v.withoutSpecialists(t, ["deployment", "configuration", "data-migration"]);
    assert.equal(out, "The subagents `agent()` may name: `evals`,\n`customer-context`, `follow-ups`.\n- **evals** — evals.");
  });
  const root = await imp("agent/lib/root-instructions.ts");
  await check("root prompt, persona dropped: a neutral opening, no roster, no stand-up, one policy marker", () => {
    const text = root.renderRootInstructions(voc);
    assert.match(text, /^# Workspace assistant/);
    assert.doesNotMatch(text, /Daily stand-up|What you own/);
    assert.equal(text.split("<!-- organization-policy -->").length, 2);
    assert.ok(text.trim().endsWith("<!-- stable-prompt-end -->"));
    assert.match(text, /`list_companies` and `get_company`/);
  });
  await check("root prompt, persona kept with exclusions: the excluded leave the roster", () => {
    const kept = { ...voc, personaBase: true, excludedSpecialists: ["deployment", "data-migration"] };
    const text = root.renderRootInstructions(kept);
    assert.match(text, /- \*\*evals\*\*/);
    assert.doesNotMatch(text, /\*\*deployment\*\*|\*\*data-migration\*\*/);
  });

  // --- Review of PR #55: product words are translated, USER DATA never is (in either direction). ------------
  console.log("\nReview probes (pure):");
  await check("R13 a pick list's choices in a refusal are the profile's own words: the relabelled message keeps them (review of #57)", async () => {
    const { validateCustom } = await imp("agent/lib/custom-fields.ts");
    // Choices that happen to be the base product's words: user data, which the model must send back as written.
    const kind = { key: "kind", label: "Kind", type: "pick_list", options: ["Customer", "Deployment", "Implementation"] };
    const refusal = validateCustom("account", { kind: "Other" }, { mode: "create", fields: [kind] }).errors[0];
    const spoken = v.speakMessageWith(voc, `Custom fields were not accepted, so nothing was written. acme: ${refusal}`);
    assert.ok(spoken.includes('must be one of: "Customer", "Deployment", "Implementation".'), spoken);
  });
  await check("R1c custom fields: a profile's own keys and options are never translated (results, briefing)", () => {
    const prof = structuredClone(fixtureProfile());
    prof.domains.deployments.custom_fields = [{ key: "customer_tier", label: "Tier", type: "pick_list", options: ["Customer A", "Other"] }];
    const pv = v.createVocabulary(prof, []);
    const out = v.outputForModelWith(pv, { deployments: [{ deploymentId: "r1", custom: { customer_tier: "Customer A" } }] });
    assert.deepEqual(out, { coverageReports: [{ coverageReportId: "r1", custom: { customer_tier: "Customer A" } }] });
  });
  await check("R1c the briefing names a custom key and its options as the profile spells them", async () => {
    const prof = structuredClone(fixtureProfile());
    prof.domains.deployments.custom_fields = [{ key: "customer_tier", label: "Tier", type: "pick_list", options: ["Customer A", "Other"] }];
    const { renderDeploymentBriefing } = await imp("agent/lib/deployment-briefing.ts");
    const b = renderDeploymentBriefing(prof);
    assert.ok(b.includes("`customer_tier`") && b.includes("Customer A|Other"), b.split("\n").find((l) => l.includes("Own fields")));
  });
  await check("R3 a stored value equal to a base enum value is translated only in a field that declares that enum", () => {
    v.schemaForModelWith(voc, { type: "object", properties: { ticketStatus: { type: "string", enum: ["Open", "Waiting on Customer"] } } });
    const out = v.outputForModelWith(voc, { ticketStatus: "Waiting on Customer", summary: "Waiting on Customer", name: "Implementation" });
    assert.deepEqual(out, { ticketStatus: "Waiting on Company", summary: "Waiting on Customer", name: "Implementation" });
  });
  await check("R3 nested note/reason/hint/warning are record data: untouched", () => {
    const rec = { interactions: [{ note: `The customer wants ${S.accounts}/x`, reason: "deployment slipped", hint: L.owner, warning: "customer" }] };
    assert.deepEqual(v.outputForModelWith(voc, rec), rec);
  });
  await check("R3 an error message keeps the ids and names it embeds", () => {
    const out = v.outputForModelWith(voc, { error: 'Customer "Deployment Holdings" (acme-deployments) was not found.' });
    assert.equal(out.error, 'Company "Deployment Holdings" (acme-deployments) was not found.');
  });
  await check("R4 a folder is rewritten only as the FIRST segment of a path", () => {
    const out = v.outputForModelWith(voc, { paths: [`${S.uploads}/sam-example-com/Top ${S.accounts}/notes.md`, `${S.accounts}/acme/context.md`] });
    assert.deepEqual(out.paths, [`${S.uploads}/sam-example-com/Top ${S.accounts}/notes.md`, "Companies/acme/context.md"]);
    assert.equal(v.toStoredPathWith(voc, `${S.uploads}/sam/Companies/x.md`), `${S.uploads}/sam/Companies/x.md`);
  });
  await check("R4 a presigned URL (key in the path AND the query string) is left exactly as issued", () => {
    const url = `https://x.blob.vercel-storage.com/${S.accounts}/acme/f.pdf?download=1&key=${S.accounts}%2Facme&p=${S.accounts}/acme`;
    assert.deepEqual(v.outputForModelWith(voc, { url, command: `curl -sSL -o "/workspace/f.pdf" "${url}"` }), { url, command: `curl -sSL -o "/workspace/f.pdf" "${url}"` });
  });
  await check("C every run path refuses an unavailable workflow (run routes, cron, app refresh) and the list reports it", () => {
    for (const f of ["app/api/ops/run/route.ts", "app/api/ops/workflows/[id]/run/route.ts", "app/api/cron/run-cron-workflows/route.ts", "lib/app-refresh.ts", "app/api/ops/workflows/route.ts"]) {
      // The list route derives it per row through workflowForList (lib/workflow-availability.ts), which calls it; the
      // app refresh through workflowAppSource (lib/app-source.ts), which calls it for every row that has a script.
      assert.match(readFileSync(join(ROOT, f), "utf8"), /workflowAvailability\(|workflowForList\(|workflowAppSource\(/, f);
    }
    assert.match(readFileSync(join(ROOT, "lib/app-source.ts"), "utf8"), /workflowAvailability\(row, v\)/);
  });
  await check("C/B no build config runs a bare `eve build` (it would put the excluded specialists back)", () => {
    const bare = /(^|&&|;|\|\|)\s*(npx\s+)?eve\s+(build|dev)\b/;
    for (const f of readdirSync(ROOT).filter((n) => /^vercel.*\.json$/.test(n))) {
      const cmd = JSON.parse(readFileSync(join(ROOT, f), "utf8")).buildCommand ?? "";
      assert.ok(!bare.test(cmd), `${f}: ${cmd}`);
    }
    for (const [name, cmd] of Object.entries(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts)) assert.ok(!bare.test(cmd), `package.json ${name}: ${cmd}`);
    assert.doesNotMatch(readFileSync(join(ROOT, "scripts/deploy.mjs"), "utf8"), /\["eve",\s*"build"\]/, "scripts/deploy.mjs");
  });

  await check("D speakMessage: prose plurals, possessives and English compounds", () => {
    assert.equal(v.speakMessageWith(voc, "No deployments for this customer's Customer-facing app (acme-deployments)."), "No coverage reports for this company's Company-facing app (acme-deployments).");
  });
  await check("R9 an account word of `team` or `person` never produces a colliding memory scope in prose", () => {
    for (const word of ["team", "person"]) {
      const prof = structuredClone(fixtureProfile());
      prof.vocabulary.account = { singular: word, plural: `${word}s` };
      const pv = v.createVocabulary(prof, []);
      assert.equal(pv.memoryPrefix, "customer");
      const t = v.speakWith(pv, "Scope to `team` for everyone-always, `customer:{id}` for customer facts, `person:{email}` for people. Pattern ^(team|customer:[^\\s:]+|person:[^\\s:]+)$");
      assert.ok(!t.includes(`\`${word}:{id}\``), t);
      assert.ok(t.includes("`customer:{id}`") && t.includes("^(team|customer:[^\\s:]+|person:[^\\s:]+)$"), t);
    }
  });
  await check("R10 with persona.base false the root prompt is domain-free (no platform, deploys, migrations)", () => {
    const text = root.renderRootInstructions(voc);
    assert.doesNotMatch(text, /platform|deploy|migration|config change/i, text.split("\n").filter((l) => /platform|deploy|migration|config change/i.test(l)).join("\n"));
  });
}

/** Phase 2, inside a copy stamped with the fixture: storage never moves. */
async function phaseStamped() {
  console.log("\nStamped with the fixture (a build copy):");
  const v = await imp("agent/lib/agent-vocabulary.ts");
  await check("the vocabulary is relabelled at module load", () => assert.equal(v.VOCABULARY_RELABELLED, true));
  // The folders this stamped copy stores its domains under: the fixture pins the names its data room already holds.
  const S = v.VOCABULARY.stored;
  const tools = await imp("agent/lib/tools.ts");
  const dataroom = await imp("agent/lib/dataroom-tools.ts");
  const memory = await imp("agent/lib/memory-tools.ts");
  const ctx = { session: { id: "s", auth: { current: null, initiator: null } } };
  const resolve = async (dynamic) => {
    const [event, handler] = Object.entries(dynamic.events)[0];
    return await handler({ type: event }, ctx);
  };
  const upsert = await resolve(tools.upsertCustomerTool);
  await check("upsert_customer is offered as upsert_company only", () => assert.deepEqual(Object.keys(upsert), ["upsert_company"]));
  await check("the static tools keep their file's name and translate too", () => assert.equal(typeof dataroom.dataroomReadTool.execute, "function"));
  // The roster tool was renamed to list_members (TOOL_ALIASES); a relabelling deployment keeps the name it had.
  const roster = await resolve(tools.listMembersTool);
  await check("list_members is offered as list_analysts only, the name this deployment already called it by", () => assert.deepEqual(Object.keys(roster), ["list_analysts"]));
  await upsert.upsert_company.execute({
    id: "stamp-co", name: "Stamp Co", analystOwner: "a@example.com",
    portfolioEntry: { portfolioId: "large-caps", portfolioEntryStage: "Kickoff", portfolioEntryProgressPct: 5, portfolioEntryRiskLevel: "Green", blockerOwner: "Company" },
    coverageReports: [{ coverageReportId: "r1", environment: "prod", region: "company-vpc", deployedVersion: "Q1", releaseStatus: "deployed", healthStatus: "healthy" }],
  }, ctx);
  const sor = await imp("agent/lib/system-of-record.ts");
  const stored = await sor.getCustomer("stamp-co");
  await check("stored under the base keys and values, exactly as before", () => {
    assert.equal(stored.fdeOwner, "a@example.com");
    assert.equal(stored.implementation.rolloutId, "large-caps");
    assert.equal(stored.implementation.blockerOwner, "Customer");
    assert.equal(stored.deployments[0].deploymentId, "r1");
    assert.equal(stored.deployments[0].region, "customer-vpc");
    assert.ok(!("analystOwner" in stored) && !("coverageReports" in stored));
  });
  // R11: fields the profile hides (account_fields.hidden, domains.<area>.fields.<key>.hidden) are not offered to the
  // model and not shown to it; storage, and every caller that is not the model, keep them.
  const params = upsert.upsert_company.inputSchema ?? {};
  const props = params.properties ?? {};
  await check("R11 hidden account fields are not upsert_company parameters (arr, seats, aeOwner, renewalDate, platform, tickets…)", () => {
    for (const k of ["arr", "arrCurrency", "seats", "aeOwner", "contractStatus", "renewalForecast", "renewalDate", "expansionPotentialArr", "successCriteria", "platform", "tickets", "solutions"]) assert.ok(!(k in props), `${k} is still offered: ${Object.keys(props).join(",")}`);
    for (const k of ["id", "name", "analystOwner", "coverageReports", "portfolioEntry", "healthReason"]) assert.ok(k in props, `${k} went missing`);
  });
  await check("R11 a hidden nested field is not a parameter; a hidden field with a fixed value still is", () => {
    const item = props.coverageReports?.items?.properties ?? {};
    assert.ok(!("buildSha" in item) && !("cost30dUsd" in item), Object.keys(item).join(","));
    assert.ok("region" in item && "environment" in item && "coverageReportId" in item, Object.keys(item).join(","));
    assert.ok(!("securityReviewStatus" in (props.portfolioEntry?.properties ?? {})));
  });
  const reads = await imp("agent/lib/read-only-tools.ts");
  await check("the empty-response guard knows the read-only tools by both names, and no write tool is among them", () => {
    assert.ok(reads.isReadOnlyTool("get_company") && reads.isReadOnlyTool("get_customer") && reads.isReadOnlyTool("list_companies"));
    for (const w of ["upsert_company", "upsert_customer", "remember", "bash", "record_interaction", "mcp_call", "dataroom_write", "dataroom_fetch_to_sandbox", "customer-context"]) assert.ok(!reads.isReadOnlyTool(w), w);
  });
  const sorForHidden = await imp("agent/lib/system-of-record.ts");
  await sorForHidden.upsertCustomer({
    id: "hidden-co", name: "Hidden Co", arr: 5, seats: 9,
    deployments: [{ deploymentId: "r1", environment: "prod", region: "ap-south-1", deployedVersion: "Q1", releaseStatus: "deployed", healthStatus: "healthy", buildSha: "abc1234" }],
  });
  const getForHidden = await resolve(tools.getCustomerTool);
  const shown = await getForHidden.get_company.execute({ id: "hidden-co" }, ctx);
  await check("R11 get_company does not show hidden fields, at either level", () => {
    assert.ok(shown.company && !("arr" in shown.company) && !("seats" in shown.company), JSON.stringify(shown));
    assert.equal(shown.company.coverageReports?.[0]?.coverageReportId, "r1", JSON.stringify(shown));
    assert.ok(!("buildSha" in shown.company.coverageReports[0]), JSON.stringify(shown.company.coverageReports[0]));
  });
  await upsert.upsert_company.execute({
    id: "hidden-co",
    coverageReports: [{ coverageReportId: "r1", environment: "prod", region: "ap-south-1", deployedVersion: "Q2", releaseStatus: "deployed", healthStatus: "healthy" }],
  }, ctx);
  const kept = await sorForHidden.getCustomer("hidden-co");
  await check("R11 storage keeps hidden values: the account's, and a nested row's the model rewrote without seeing them", () => {
    assert.equal(kept.arr, 5);
    assert.equal(kept.seats, 9);
    assert.equal(kept.deployments[0].deployedVersion, "Q2");
    assert.equal(kept.deployments[0].buildSha, "abc1234");
  });
  await check("R11 nothing is copied back from a read: a hidden value the model never sent is never written (mold_v1-136)", () => {
    // The system of record changes only the fields a patch names, so the old carry-over (restoreHiddenWith) only
    // turned a stored hidden value into an explicit write of what was read, putting back a concurrent change.
    const src = readFileSync(join(ROOT, "agent/lib/model-facing/tools/model-facing.ts"), "utf8");
    assert.ok(!/restoreHiddenWith\(/.test(src), "model-facing.ts still re-sends stored hidden values");
  });
  const hiddenOut = await upsert.upsert_company.execute({ id: "hidden-co", arr: 99 }, ctx);
  await check("R11 a hidden field the model sends anyway is not written, and the write's result does not show it", async () => {
    assert.equal((await sorForHidden.getCustomer("hidden-co")).arr, 5);
    assert.ok(!("arr" in (hiddenOut.company ?? {})), JSON.stringify(hiddenOut));
  });
  // The same one level down (review of #80): a hidden field of a nested row the model sends anyway is dropped, the
  // row's other change lands, and the stored hidden value is untouched.
  const nestedOut = await upsert.upsert_company.execute({ id: "hidden-co", coverageReports: [{ coverageReportId: "r1", deployedVersion: "Q3", buildSha: "fffffff" }] }, ctx);
  await check("R11 a hidden NESTED field the model sends anyway is not written, and the result does not show it", async () => {
    const row = (await sorForHidden.getCustomer("hidden-co")).deployments.find((d) => d.deploymentId === "r1");
    assert.equal(row.buildSha, "abc1234", JSON.stringify(row));
    assert.equal(row.deployedVersion, "Q3", "the row's other change landed");
    assert.ok(!("buildSha" in (nestedOut.company?.coverageReports?.[0] ?? {})), JSON.stringify(nestedOut));
  });

  // R12: the account record's OWN fields (account_fields.custom_fields: `notes`, `house_view` in the fixture). Offered
  // as `custom` beside the hidden fields' absence, stored and read back VERBATIM (user data: a note that says
  // a stored path or "deployment" is not the product's words), merged per key, and refused when undeclared.
  const NOTE = `Read ${S.accounts}/acme/filings/q1.pdf and ${S.deliveries}/acme/v1 again.\nThe deployment of capital into affordable housing is the customer_id question; ${L.owner}: n/a; list_customers said 3 customers.`;
  await check("R12 the account's own fields are an upsert_company parameter (`custom`), hidden account fields still are not", () => {
    assert.ok("custom" in props, Object.keys(props).join(","));
    assert.ok(!("arr" in props) && !("seats" in props));
  });
  await upsert.upsert_company.execute({ id: "notes-co", name: "Notes Co", custom: { notes: NOTE, house_view: "neutral" } }, ctx);
  const sorNotes = await imp("agent/lib/system-of-record.ts");
  await check("R12 stored verbatim under the declared keys (a pick is stored as the profile spells it)", async () => {
    assert.deepEqual((await sorNotes.getCustomer("notes-co")).custom, { notes: NOTE, house_view: "Neutral" });
  });
  const getNotes = (await resolve(tools.getCustomerTool)).get_company;
  const notesRead = await getNotes.execute({ id: "notes-co" }, ctx);
  await check("R12 get_company returns `custom` exactly as stored: keys and values untranslated", () => {
    assert.deepEqual(notesRead.company.custom, { notes: NOTE, house_view: "Neutral" }, JSON.stringify(notesRead));
  });
  const listNotes = (await resolve(tools.listCustomersTool)).list_companies;
  const listedCo = (await listNotes.execute({}, ctx)).companies.find((c) => c.id === "notes-co");
  await check("R12 list_companies carries only the show_in_list own fields (not a long note)", () => assert.deepEqual(listedCo.custom, { house_view: "Neutral" }, JSON.stringify(listedCo)));
  await upsert.upsert_company.execute({ id: "notes-co", custom: { house_view: "Positive" } }, ctx);
  await check("R12 a partial `custom` merges: the note it did not mention is kept", async () => {
    assert.deepEqual((await sorNotes.getCustomer("notes-co")).custom, { notes: NOTE, house_view: "Positive" });
  });
  await check("R12 an undeclared key is refused and nothing is written", async () => {
    await assert.rejects(upsert.upsert_company.execute({ id: "notes-co", healthReason: "changed", custom: { rating: "Buy" } }, ctx), /Custom fields were not accepted, so nothing was written\. notes-co: There is no custom field "rating" here\. The custom fields are: `notes` \("Notes", long text\); `house_view`/);
    const after = await sorNotes.getCustomer("notes-co");
    assert.notEqual(after.healthReason, "changed");
    assert.deepEqual(after.custom, { notes: NOTE, house_view: "Positive" });
  });
  await check("R12 a wrong type is refused", async () => {
    await assert.rejects(upsert.upsert_company.execute({ id: "notes-co", custom: { house_view: "Bullish" } }, ctx), /"House view" \(house_view\) must be one of: "Positive", "Neutral", "Negative"\./);
    await assert.rejects(upsert.upsert_company.execute({ id: "notes-co", custom: { notes: { text: "x" } } }, ctx));
  });
  await upsert.upsert_company.execute({ id: "hidden-co", arr: 1234, custom: { notes: "Met the CFO." } }, ctx);
  await check("R12 hidden + custom: an own field is written beside a hidden one the model sent, which is not; stored hidden values survive", async () => {
    const both = await sorNotes.getCustomer("hidden-co");
    assert.equal(both.arr, 5);
    assert.equal(both.seats, 9);
    assert.deepEqual(both.custom, { notes: "Met the CFO." });
  });
  await check("R12 `custom_append` is offered for the long-text notes, so a long note is never resent whole", () => assert.ok("custom_append" in props, Object.keys(props).join(",")));
  await upsert.upsert_company.execute({ id: "notes-co", custom_append: { notes: `${S.accounts}/acme: follow-up call booked.` } }, ctx);
  await check("R12 an append lands after the stored note, verbatim", async () => {
    assert.equal((await sorNotes.getCustomer("notes-co")).custom.notes, `${NOTE}\n\nCustomers/acme: follow-up call booked.`);
  });
  await upsert.upsert_company.execute({ id: "notes-co", custom: { notes: null, house_view: null } }, ctx);
  await check("R12 null clears; a record with no own values left has no `custom` at all", async () => {
    assert.ok(!("custom" in (await sorNotes.getCustomer("notes-co"))));
  });

  const store = (await imp("agent/lib/dataroom-store.ts")).getDataroomStore((await imp("agent/lib/org-context.ts")).DEFAULT_ORG);
  await store.write(`${S.deliveries}/stamp-co/v1/platform/organization.json`, "{}\n");
  const read = await dataroom.dataroomReadTool.execute({ path: "Coverage-reports/stamp-co/v1/platform/organization.json" }, ctx);
  await check("a display path reads the stored folder, and comes back displayed", () => assert.deepEqual(read, { path: "Coverage-reports/stamp-co/v1/platform/organization.json", content: "{}\n" }));
  const saved = await memory.rememberTool.execute({ scope: "company:stamp-co", key: "k", value: "v" }, ctx);
  const store2 = await imp("agent/lib/memory-store.ts");
  const rows = await store2.listMemories("customer:stamp-co");
  await check("a memory written as company:… is the customer kind in storage, shown as company:…", () => {
    assert.equal(saved.memory.scope, "company:stamp-co");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, "customer:stamp-co");
  });
  await check("the old spelling still reads it", async () => assert.equal((await store2.listMemories("company:stamp-co")).length, 1));

  console.log("\nReview probes (stamped):");
  // R1 / A: `args` reach the workflow as ITS script reads them. The fake run route below runs the real lib/workflow-args
  // (alignWorkflowArgs when this code has it), exactly as app/api/ops/run does.
  const { createServer } = await import("node:http");
  const wa = await imp("lib/workflow-args.ts");
  const SCRIPTS = {
    "qbr-prep": 'const c = (args && args.customerId) || "";\nreturn c;',            // the base library: reads customerId
    "my-coverage": 'const c = (args && args.companyId) || "";\nreturn c;',          // written in this deployment: reads companyId
  };
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { target, args: raw = {} } = JSON.parse(body || "{}");
      const script = SCRIPTS[target];
      const args = wa.alignWorkflowArgs ? wa.alignWorkflowArgs(script, raw) : raw;
      seen.push({ target, args });
      const problem = wa.validateWorkflowArgs(script, args);
      res.setHeader("content-type", "application/json");
      if (problem) { res.statusCode = 400; res.end(JSON.stringify({ error: problem.message, ...(problem.expected ? { expects: problem.expected } : {}) })); return; }
      res.end(JSON.stringify({ ok: true, runId: "run-1", workflow: target, result: { summary: "the customer is fine", got: args } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.WEB_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  process.env.CRON_SECRET = "test";
  const run = await imp("agent/lib/run-tools.ts");
  const trigger = run.triggerWorkflowTool;
  const call = (workflow, args) => trigger.execute({ workflow, args }, ctx).catch((e) => ({ thrown: e.message }));
  const ok = await call("qbr-prep", { companyId: "acme-deployments" });
  await check("R1/A a LIBRARY workflow (reads args.customerId) gets the model's companyId as customerId", () => {
    assert.deepEqual(seen.at(-1).args, { customerId: "acme-deployments" });
    assert.equal(ok.ran, true, JSON.stringify(ok));
  });
  await check("R1 a workflow's return value is its data: not translated", () => assert.deepEqual(ok.result, { summary: "the customer is fine", got: { customerId: "acme-deployments" } }));
  const authored = await call("my-coverage", { companyId: "acme" });
  await check("A a workflow WRITTEN HERE (reads args.companyId) gets companyId, as written, and runs", () => {
    assert.deepEqual(seen.at(-1).args, { companyId: "acme" });
    assert.equal(authored.ran, true, JSON.stringify(authored));
  });
  const refused = await call("qbr-prep", { companyId: "a", region: "x" });
  await check("R1/A a library workflow's refusal names the keys as the model writes them", () => {
    const text = refused.thrown ?? refused.error ?? "";
    assert.match(text, /never reads "region"\..*It reads: companyId\./, text);
  });
  const refused2 = await call("my-coverage", { foo: 1 });
  await check("A an authored workflow's refusal names ITS key (companyId), untranslated", () => {
    const text = refused2.thrown ?? refused2.error ?? "";
    assert.match(text, /never reads "foo"\..*It reads: companyId\./, text);
  });
  server.close();

  // R2: free text the model writes is stored exactly as written.
  await upsert.upsert_company.execute({ id: "acme-deployments", name: "Portfolios", healthReason: "Company" }, ctx);
  await upsert.upsert_company.execute({ id: "acme-notes", name: "Notes Co", healthReason: "Companies/peers are cheaper" }, ctx);
  const r2a = await sor.getCustomer("acme-deployments");
  const r2b = await sor.getCustomer("acme-notes");
  await check("R2 a name that equals a display label, and free text equal to an enum label, are stored as written", () => {
    assert.equal(r2a?.id, "acme-deployments");
    assert.equal(r2a?.name, "Portfolios");
    assert.equal(r2a?.healthReason, "Company");
  });
  await check("R2 free text shaped like a display path is stored as written", () => assert.equal(r2b?.healthReason, "Companies/peers are cheaper"));

  // R3: stored content comes back as stored.
  await upsert.upsert_company.execute({ id: "acme-stored", name: "Implementation", healthReason: "Customer" }, ctx);
  const get = await resolve(tools.getCustomerTool);
  const got = await get.get_company.execute({ id: "acme-stored" }, ctx);
  await check("R3 a stored name/reason equal to a base word is returned as stored", () => {
    assert.equal(got.company?.name, "Implementation", JSON.stringify(got));
    assert.equal(got.company?.healthReason, "Customer");
  });
  const pc = await imp("agent/lib/prompt-context.ts");
  const block = pc.renderContextBlock({
    name: "Long-term team memory (recall)", guidance: "Memories.", viewer: { orgId: "o" }, maxItems: 5, maxTokens: 2000,
    entries: [{ id: "m1", source: "memories", provenance: "p", audience: { orgId: "o" }, observedAt: "2026-01-01", trust: "untrusted", data: { scope: "customer:acme", key: "k", value: `The customer's deployment is ${S.accounts}/acme` } }],
  });
  await check("R3 recalled memories keep their saved value (context blocks translate keys, not data)", () => {
    assert.ok(block.includes(`The customer's deployment is ${S.accounts}/acme`), block);
    assert.ok(block.includes("company:acme"), block);
  });

  // R4: a folder deep inside a path is not a domain folder.
  await store.write(`${S.uploads}/sam-example-com/Top ${S.accounts}/notes.md`, "hi\n");
  const listed = await dataroom.dataroomListTool.execute({ prefix: `${S.uploads}/sam-example-com` }, ctx);
  await check(`R4 an upload under 'Top ${S.accounts}/' is listed at its real path`, () => assert.ok(listed.paths?.includes(`${S.uploads}/sam-example-com/Top ${S.accounts}/notes.md`), JSON.stringify(listed)));
  const readBack = await dataroom.dataroomReadTool.execute({ path: `${S.uploads}/sam-example-com/Top ${S.accounts}/notes.md` }, ctx);
  await check("R4 …and reads back from it", () => assert.equal(readBack.content, "hi\n", JSON.stringify(readBack)));

  // R5: publish_artifact's `path` is a SANDBOX path: never converted.
  const commands = [];
  const sandboxCtx = { ...ctx, getSandbox: async () => ({ run: async ({ command }) => { commands.push(command); return { stdout: "", stderr: "", exitCode: 0 }; } }) };
  await tools.publishArtifactTool.execute({ filename: "r.xlsx", path: "Companies/acme/report.xlsx" }, sandboxCtx).catch(() => null);
  await check("R5 publish_artifact reads the sandbox file at the path the model gave", () => assert.ok(commands[0]?.includes('"Companies/acme/report.xlsx"'), commands[0]));

  // R6: the workflow library a workspace is provisioned with, under this profile.
  const libView = await imp("agent/lib/workflow-library-view.ts").catch(() => null);
  const lib = libView ? libView.deploymentWorkflowLibrary() : (await imp("agent/lib/workflow-library.generated.ts")).WORKFLOW_LIBRARY;
  await check("R6 no provisioned workflow delegates to an excluded specialist", () => {
    const bad = lib.filter((w) => /subagent:\s*"(deployment|configuration|data-migration|customer-context)"/.test(w.script)).map((w) => w.name);
    assert.deepEqual(bad, []);
  });
  await check("R6 no provisioned workflow's text names a base tool or word", () => {
    const bad = lib.filter((w) => new RegExp(`list_fdes|list_members|get_customer|list_customers|upsert_customer|\\bcustomers?\\b|\\b${L.singular}|\\{(member|members|owner)\\}`, "i").test([w.description, ...w.steps, ...(w.script.match(/"(?:[^"\\]|\\.)*"/g) ?? []).filter((q) => !/^"(deployment|configuration|data-migration|customer-context|research|follow-ups|evals|app-author|browser|workflow-author)"$/.test(q))].join(" "))).map((w) => w.name);
    assert.deepEqual(bad, []);
  });
  await check("R6 a provisioned workflow still reads its args by the base key the run route checks", () => {
    for (const w of lib) assert.ok(!/args\.companyId/.test(w.script), w.name);
  });

  // R8: the Insights rail reads the model-facing tool names and keys.
  const insights = await imp("app/_components/insights.ts");
  const derived = insights.deriveInsights([{ parts: [
    { type: "dynamic-tool", toolName: "list_companies", toolCallId: "c1", state: "output-available", output: { companies: [{ id: "acme", name: "Acme" }] } },
    { type: "dynamic-tool", toolName: "get_company", toolCallId: "c2", state: "output-available", output: { found: true, company: { id: "beta", name: "Beta", analystOwner: "sam@example.com" } } },
  ] }]);
  await check("R8 Insights: companies listed and fetched under the relabel reach the rail", () => assert.deepEqual(derived.customers.map((c) => c.id).sort(), ["acme", "beta"]));
  await check("R8 Insights: the covering analyst reaches the People rail", () => assert.equal(derived.people.length, 1, JSON.stringify(derived.people)));
  const display = await imp("app/_components/tool-display.ts");
  await check("R8 tool display: a renamed tool keeps its curated name and argument summary", () => {
    assert.equal(display.toolDisplayName("get_company"), "Get company");
    assert.equal(display.toolCallSummary("get_company", { note: "zzz", id: "beta" }), "beta");
  });

  // C: workspaces provisioned BEFORE the exclusion keep the base library rows; what each can do is derived here.
  const availMod = await imp("lib/workflow-availability.ts").catch(() => null);
  const baseLib = (await imp("agent/lib/workflow-library.generated.ts")).WORKFLOW_LIBRARY;
  const assign = baseLib.find((w) => w.name === "assign-account");
  await check("C an existing workspace's untouched library row that needs an excluded specialist is unavailable, with the reason", () => {
    assert.ok(availMod, "lib/workflow-availability.ts missing");
    const a = availMod.workflowAvailability({ name: assign.name, script: assign.script });
    assert.equal(a.available, false);
    assert.deepEqual(a.needsExcluded, ["customer-context"]);
    // The reason is shown to a person: it never names an excluded specialist (check:ui-vocabulary).
    assert.match(a.reason, /delegates to a specialist this workspace does not use/);
    assert.doesNotMatch(a.reason, /customer-context/);
  });
  await check("C a library row a person EDITED to still use an excluded specialist cannot run either, and says why", () => {
    const a = availMod.workflowAvailability({ name: assign.name, script: assign.script + "\n// edited" });
    assert.equal(a.available, false);
    assert.deepEqual(a.needsExcluded, ["customer-context"]);
    assert.match(a.reason, /delegates to a specialist this workspace does not use, so it cannot run here/);
    assert.doesNotMatch(a.reason, /customer-context/);
  });
  await check("C …and edited to use this workspace's specialists it is available", () => {
    assert.deepEqual(availMod.workflowAvailability({ name: assign.name, script: assign.script.replace(/customer-context/g, "research-notes") }), { available: true });
  });
  await check("C the row of an excluded specialist is unavailable; a kept specialist's row, and a scripted row of the same name, are not", () => {
    const a = availMod.workflowAvailability({ name: "customer-context", script: null, trigger: "on delegation" });
    assert.equal(a.available, false);
    assert.doesNotMatch(a.reason, /customer-context/);
    assert.equal(availMod.workflowAvailability({ name: "research", script: null, trigger: "on delegation" }).available, true);
    assert.equal(availMod.workflowAvailability({ name: "customer-context", script: 'return await agent("x");', trigger: "manual" }).available, true);
  });
  await check("C reversible: under the default profile the same row is available (nothing was written)", async () => {
    const { DEFAULT_DOMAINS } = await imp("agent/lib/deployment-profile.generated.ts");
    const base = structuredClone((await imp("agent/lib/deployment-profile.generated.ts")).DEPLOYMENT_PROFILE);
    const defaults = JSON.parse(readFileSync(join(ROOT, "profiles/00-default.json"), "utf8"));
    const dv = v.createVocabulary({ ...base, vocabulary: defaults.vocabulary, dataroom: { ...base.dataroom, domains: defaults.dataroom.domains }, domains: DEFAULT_DOMAINS, specialists: { exclude: [] } }, []);
    assert.equal(availMod.workflowAvailability({ name: assign.name, script: assign.script }, dv).available, true);
  });
  await check("C the workflows view says why library workflows are missing", () => {
    const note = availMod.withheldLibraryNote();
    assert.match(note ?? "", /of the 13 library workflows are not part of this workspace/);
  });
  // D: validation errors speak the model's words — paths and the values they list.
  const bad = await upsert.upsert_company.execute({ id: "acme-bad", portfolioEntry: { portfolioEntryStage: "Kickoff", portfolioEntryProgressPct: 1, portfolioEntryRiskLevel: "Green", blockerOwner: "Nobody" } }, ctx).catch((e) => ({ thrown: e.message }));
  await check("D a validation error names the field and its choices in the model's words", () => {
    const text = bad.thrown ?? "";
    assert.match(text, /portfolioEntry\.blockerOwner/, text);
    assert.match(text, /"Company"/, text);
    assert.doesNotMatch(text, /implementation|"Customer"/, text);
  });

  // PLAUSIBLE: a session that started before the relabel was deployed never sees session.started again.
  await check("P a renamed tool resolves on every turn, so a session begun before the relabel still gets it", () => {
    assert.ok(tools.upsertCustomerTool.events?.["turn.started"], Object.keys(tools.upsertCustomerTool.events ?? {}).join(","));
  });
}

/**
 * Phase 3 (R7): specialists.exclude is a LIST the generators honour. Nothing is moved: a git checkout of a
 * stamped build is the build, so a clone regenerates the same tree, and a dev clone shows no deleted files.
 */
async function phaseExclusion(copy) {
  console.log("\nspecialists.exclude (R7):");
  const ALL = ["app-author", "browser", "configuration", "customer-context", "data-migration", "deployment", "evals", "follow-ups", "research", "workflow-author"];
  const EXCLUDED = ["deployment", "configuration", "data-migration", "customer-context"];
  const subagents = (dir) => readdirSync(join(dir, "agent/subagents")).filter((n) => existsSync(join(dir, "agent/subagents", n, "agent.ts"))).sort();
  const registry = (dir) => readFileSync(join(dir, "agent/lib/subagent-registry.generated.ts"), "utf8");
  await check("R7 generating the profile moves no files: every specialist directory is still there", () => assert.deepEqual(subagents(copy), ALL));
  await check("R7 …and nothing appeared outside the tree", () => assert.ok(!existsSync(join(copy, ".profile-excluded")), ".profile-excluded/ exists"));
  await check("R7 the registry (UI lists, workflow author, data-room templates) leaves the excluded out", () => {
    for (const k of EXCLUDED) assert.ok(!registry(copy).includes(`"${k}"`), `${k} still in the registry`);
    assert.ok(registry(copy).includes('"research"'));
  });
  // A "git clone" of the stamped copy: the tracked tree only (.profile-excluded/ was gitignored), regenerated.
  const clone = mkdtempSync(join(tmpdir(), "vocab-clone-"));
  try {
    for (const e of ["agent", "lib", "data", "scripts", "library", "dm.md", "package.json", "profiles", "app"]) if (existsSync(join(copy, e))) cpSync(join(copy, e), join(clone, e), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(clone, "node_modules"), "dir");
    const again = spawnSync(process.execPath, ["scripts/gen-subagent-meta.mjs"], { cwd: clone, encoding: "utf8" });
    const gen2 = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs"], { cwd: clone, encoding: "utf8" });
    await check("R7 a clone of the stamped build regenerates cleanly, to the same registry", () => {
      assert.equal(again.status, 0, again.stderr);
      assert.equal(gen2.status, 0, gen2.stderr);
      assert.equal(registry(clone), registry(copy));
    });
    // The build is where eve discovers directories: the excluded ones are hidden for exactly its duration.
    const plan = spawnSync(process.execPath, ["scripts/eve-build.mjs", "--plan"], { cwd: clone, encoding: "utf8" });
    await check("R7 the eve build hides exactly the excluded specialists, and restores them", () => {
      assert.equal(plan.status, 0, plan.stderr || "scripts/eve-build.mjs missing");
      assert.deepEqual(JSON.parse(plan.stdout).hide.sort(), [...EXCLUDED].sort());
      assert.deepEqual(subagents(clone), ALL);
    });
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
  rmSync(join(copy, "profiles/50-relabelled.json"));
  const r = spawnSync(process.execPath, ["scripts/gen-subagent-meta.mjs"], { cwd: copy, encoding: "utf8" });
  await check("R7 without the profile the registry is the default one again", () => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(registry(copy), readFileSync(join(ROOT, "agent/lib/subagent-registry.generated.ts"), "utf8"));
  });
}

/**
 * Phase 4 (B): two eve runs in one directory, a generator during a run, a run killed mid-build. A fake
 * node_modules/.bin/eve sleeps and records what agent/subagents/ holds when eve would read it.
 */
async function phaseConcurrency(stamped) {
  console.log("\neve-build under concurrency (B):");
  const { spawn } = await import("node:child_process");
  const { writeFileSync, chmodSync } = await import("node:fs");
  const EXCLUDED = ["configuration", "customer-context", "data-migration", "deployment"];
  const dir = mkdtempSync(join(tmpdir(), "vocab-concurrent-"));
  try {
    for (const e of ["agent", "lib", "data", "scripts", "library", "dm.md", "package.json", "profiles", "app"]) if (existsSync(join(stamped, e))) cpSync(join(stamped, e), join(dir, e), { recursive: true });
    cpSync(FIXTURE, join(dir, "profiles/50-relabelled.json"));
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    for (const dep of ["zod", "drizzle-orm", "postgres", "eve"]) if (existsSync(join(ROOT, "node_modules", dep))) symlinkSync(join(ROOT, "node_modules", dep), join(dir, "node_modules", dep), "dir");
    writeFileSync(join(dir, "node_modules/.bin/eve"), "#!/bin/sh\nsleep 2\nls agent/subagents | tr '\\n' ' ' >> listings.txt\necho >> listings.txt\n");
    chmodSync(join(dir, "node_modules/.bin/eve"), 0o755);
    const wrapper = (env = {}) => spawn(process.execPath, ["scripts/eve-build.mjs", "build"], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    const done = (p) => new Promise((r) => p.on("exit", (code) => r(code)));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const listings = () => (existsSync(join(dir, "listings.txt")) ? readFileSync(join(dir, "listings.txt"), "utf8").trim().split("\n").filter(Boolean) : []);
    const present = () => readdirSync(join(dir, "agent/subagents")).filter((n) => existsSync(join(dir, "agent/subagents", n, "agent.ts")));
    const clean = () => rmSync(join(dir, "listings.txt"), { force: true });

    // Two builds, 0.5 s apart.
    clean();
    const a = wrapper();
    await sleep(500);
    const b = wrapper();
    const codes = await Promise.all([done(a), done(b)]);
    await check("B two concurrent builds: each eve sees the roster WITHOUT the excluded specialists", () => {
      assert.deepEqual(codes, [0, 0]);
      const l = listings();
      assert.equal(l.length, 2, l.join(" / "));
      for (const line of l) for (const k of EXCLUDED) assert.ok(!line.split(" ").includes(k), `a build saw ${k}: ${line}`);
    });
    await check("B …and afterwards every directory is back, with no lock left", () => {
      for (const k of EXCLUDED) assert.ok(present().includes(k), `${k} missing`);
      assert.ok(!existsSync(join(dir, ".eve-build-hidden")), ".eve-build-hidden left behind");
    });

    // The factory's packs.py apply runs gen-subagent-meta while a build may be running.
    clean();
    const c = wrapper();
    await sleep(500);
    const meta = spawnSync(process.execPath, ["scripts/gen-subagent-meta.mjs"], { cwd: dir, encoding: "utf8" });
    await done(c);
    await check("B gen-subagent-meta during a build leaves the build's hidden directories alone", () => {
      assert.equal(meta.status, 0, meta.stderr);
      const l = listings();
      for (const k of EXCLUDED) assert.ok(!l[0]?.split(" ").includes(k), `the build saw ${k}: ${l[0]}`);
    });

    // A second run that may not wait refuses; it never builds the full roster.
    clean();
    const d = wrapper();
    await sleep(500);
    const e = wrapper({ EVE_BUILD_LOCK_WAIT_MS: "200" });
    const [codeD, codeE] = await Promise.all([done(d), done(e)]);
    await check("B a run that cannot wait for the lock refuses (exit 75) instead of building", () => {
      assert.equal(codeD, 0);
      assert.equal(codeE, 75);
      assert.equal(listings().length, 1);
    });

    // A run killed mid-build: the next generator restores its directories (its pid is dead).
    clean();
    const f = wrapper();
    await sleep(600);
    f.kill("SIGKILL");
    await done(f);
    await sleep(100);
    const hiddenNow = EXCLUDED.filter((k) => !present().includes(k));
    const meta2 = spawnSync(process.execPath, ["scripts/gen-subagent-meta.mjs"], { cwd: dir, encoding: "utf8" });
    await check("B a build killed with SIGKILL is restored by the next generator run", () => {
      assert.deepEqual(hiddenNow.sort(), [...EXCLUDED].sort(), "the killed build should have hidden them");
      assert.equal(meta2.status, 0, meta2.stderr);
      for (const k of EXCLUDED) assert.ok(present().includes(k), `${k} not restored`);
      assert.ok(!existsSync(join(dir, ".eve-build-hidden/lock.json")), "stale lock left");
    });
    await sleep(2200); // let the orphaned fake eve finish before the directory goes
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--phase") && process.argv[process.argv.indexOf("--phase") + 1] === "stamped") {
  await phaseStamped();
  console.log(`\n${passed} stamped check(s) passed`);
} else {
  await phaseUnits();
  const copy = mkdtempSync(join(tmpdir(), "vocab-stamped-"));
  try {
    for (const e of ["agent", "lib", "data", "scripts", "library", "dm.md", "package.json"]) cpSync(join(ROOT, e), join(copy, e), { recursive: true });
    mkdirSync(join(copy, "profiles"));
    // The stamped deployment opts into a workflow library (base code ships none): its text must reach the model in
    // the profile's words, and what it provisions must leave out what the profile excludes.
    cpSync(join(ROOT, "library/account-delivery/profile.json"), join(copy, "profiles/40-library-account-delivery.json"));
    cpSync(join(ROOT, "app/_components"), join(copy, "app/_components"), { recursive: true });
    cpSync(join(ROOT, "profiles/00-default.json"), join(copy, "profiles/00-default.json"));
    cpSync(FIXTURE, join(copy, "profiles/50-relabelled.json"));
    symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"), "dir");
    const meta = spawnSync(process.execPath, ["scripts/gen-subagent-meta.mjs"], { cwd: copy, encoding: "utf8" });
    assert.equal(meta.status, 0, meta.stderr);
    const gen = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs"], { cwd: copy, encoding: "utf8" });
    assert.equal(gen.status, 0, gen.stderr);
    const lib = spawnSync(process.execPath, ["scripts/build-workflow-library.mjs"], { cwd: copy, encoding: "utf8" });
    assert.equal(lib.status, 0, lib.stderr);
    const env = { ...process.env, DATAROOM_DIR: join(copy, ".dataroom") };
    for (const k of Object.keys(env)) if (/^(DATABASE_URL|POSTGRES_URL|BLOB_READ_WRITE_TOKEN)$/.test(k)) delete env[k];
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/test-agent-vocabulary.mjs", "--phase", "stamped"], { cwd: copy, env, encoding: "utf8" });
    process.stdout.write(r.stdout);
    if (r.status !== 0) { process.stderr.write(r.stderr); process.exitCode = 1; }
    await phaseConcurrency(copy);
    await phaseExclusion(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  console.log(`\nagent vocabulary: ${passed} check(s) passed${process.exitCode ? " — AND SOME FAILED" : ""}`);
}
