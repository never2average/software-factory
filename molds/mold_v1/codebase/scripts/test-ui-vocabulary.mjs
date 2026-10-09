#!/usr/bin/env node
/**
 * Behavioural tests for what a PERSON reads under a relabelling profile — the pure functions check:ui-vocabulary's
 * scans cannot see run: keys shown in JSON and exports (lib/ui-keys.ts), ops API errors (lib/ops-errors.ts), the
 * base library rows a workspace does not run (lib/workflow-availability.ts), enum values a profile shows without a
 * label (lib/profile-domains.ts), and the profile generator under a concurrent eve build.
 *
 *   npm run test:ui-vocabulary
 *
 * DEFAULT runs here, against this checkout's default profile: every function is the identity, so a deployment that
 * relabels nothing reads exactly what it read before (lib/ui-words.ts's words are pinned by check:ui-vocabulary).
 * RELABELLED re-runs this file inside a throwaway copy stamped with scripts/fixtures/agent-vocabulary/
 * 50-relabelled.json, because the profile is read at module load, the way a build reads it.
 * RECORDS (R) holds the record words (the account, the two record areas, the second one's group) to the profile under
 * all three: this checkout's default profile, the relabelled copy, and a copy stamped with scripts/fixtures/
 * ui-vocabulary/50-neutral-records.json, which calls each record by a neutral word and relabels nothing else. No
 * text the product writes outside the agent (a label made from a key, a record kind, a workflow step's framing, a
 * new workspace's README, what the seeders write) spells a record's stored name; and the record-word audit
 * (scripts/lib/record-literals.mjs) holds every string literal of app/, components/, lib/ and the seeders to that.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scratchDir } from "./lib/checkout-copy.mjs";

// The web app's `@/` alias and extensionless imports, and Next's `server-only` guard (a no-op outside a client
// bundle), so a server module such as lib/org-seed.ts loads here as it does in a route.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (!/\\.[cm]?[jt]sx?$/.test(s)) return await n(s + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);

const ROOT = process.cwd();
const STAMPED = process.argv.includes("--stamped");
/** `--records-only`: a stamped copy whose profile is not the relabelled fixture runs the R checks alone. */
const RECORDS_ONLY = process.argv.includes("--records-only");
const NEUTRAL_FIXTURE = join(new URL("..", import.meta.url).pathname, "scripts/fixtures/ui-vocabulary/50-neutral-records.json");
const FIXTURE = join(new URL("..", import.meta.url).pathname, "scripts/fixtures/agent-vocabulary/50-relabelled.json");
const { LEGACY_MEMBER } = await import(pathToFileURL(join(process.cwd(), "agent/lib/legacy-member.ts")).href);
const { auditRecordLiterals, recordProseWords, recordTokens, STORED_RECORDS } = await import(pathToFileURL(join(process.cwd(), "scripts/lib/record-literals.mjs")).href);
const BASE = new Set(["customer", "customers", "deployment", "deployments", "implementation", "implementations", "rollout", "rollouts", LEGACY_MEMBER.singular.toLowerCase(), LEGACY_MEMBER.plural.toLowerCase()]);
const baseWords = (t) => [...String(t).matchAll(/[A-Za-z0-9]+/g)].flatMap((m) => m[0].split(/(?<=[a-z0-9])(?=[A-Z])/)).filter((p) => BASE.has(p.toLowerCase()));
let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`);
    process.exitCode = 1;
  }
};
/** A module, or a stand-in whose every export throws "missing" — so each check fails on its own, not the file. */
const imp = (rel) =>
  import(pathToFileURL(join(ROOT, rel)).href).catch(
    () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => { throw new Error(`${rel} is missing (or does not load)`); }) }),
  );
/** This tree's stored data-room folder names, by id (the profile's: agent/lib/dataroom-folders.ts). A stamped copy
 *  that pins other names reads its own; no name is spelled here. */
const { FOLDER: F } = await imp("agent/lib/dataroom-folders.ts");
const zodIssue = (path, message) => ({ name: "ZodError", issues: [{ path, message }] });
/** The default profile's member words (what the default deployment's people read), and the member's LEGACY words
 *  (agent/lib/legacy-member.ts), which no deployment's people may read in text the product writes. */
const BASE_VOCAB = JSON.parse(readFileSync(join(ROOT, "profiles/00-default.json"), "utf8")).vocabulary;
const [BASE_MEMBER, BASE_MEMBERS] = [BASE_VOCAB.member.singular, BASE_VOCAB.member.plural];
const ROLE_WORD = new RegExp(`\\b(${LEGACY_MEMBER.singular}|${LEGACY_MEMBER.plural})\\b|forward-deployed`, "i");
const RECORD = { customerId: "acme", deploymentId: "dep-1", implementationStage: "UAT", rolloutId: "r-1", deployment_model: "k8s", fdeOwner: "a@x.io", note: "the customer asked for a deployment" };

async function relabelled() {
  console.log("\nrelabelled profile (the fixture):");
  const keys = await imp("lib/ui-keys.ts");
  await check("5 a record's KEYS read in the profile's words wherever JSON is shown or copied; values stay verbatim", () => {
    const shown = JSON.parse(keys.jsonForPeople({ record: RECORD, rows: [RECORD] }, 2));
    for (const r of [shown.record, shown.rows[0]]) {
      for (const k of Object.keys(r)) if (k !== "deployment_model") assert.deepEqual(baseWords(k), [], `key ${k}`);
      assert.equal(r.companyId, "acme");
      assert.equal(r.note, "the customer asked for a deployment", "a value is data");
    }
  });
  await check("9 speakKey translates the record areas' own keys only: deployment_model / deployment_strategy stay", () => {
    assert.equal(keys.speakKey("customer_id"), "company_id");
    assert.equal(keys.speakKey("deployment_model"), "deployment_model");
    assert.equal(keys.speakKey("deployment_strategy"), "deployment_strategy");
    assert.notEqual(keys.speakKey("deployment_id"), "deployment_id");
    assert.notEqual(keys.speakKey("implementation_stage"), "implementation_stage");
    assert.equal(keys.humanizeKey("fdeOwner"), "Covering analyst");
    assert.equal(keys.humanizeKey("accountOwner"), "Covering analyst", "the owner's neutral key reads the same label");
    assert.equal(keys.humanizeKey("account_owner"), "Covering analyst");
    // The second owner: this profile does not name it, so it reads the default's neutral label under both keys.
    for (const k of ["aeOwner", "ae_owner", "secondaryOwner", "secondary_owner"]) assert.equal(keys.humanizeKey(k), "Secondary owner", k);
  });

  const wb = await imp("lib/workbook-fields.ts");
  const { DOMAIN_FIELDS: FIELDS } = await imp("lib/deployment-profile.generated.ts");
  await check("9b a record area's OWN sheet names each of its columns in the profile's words, deployment_strategy included (review of #62)", () => {
    const snake = (k) => k.replace(/([A-Z])/g, "_$1").toLowerCase();
    for (const [sheet, area] of [[F.deliveries, "deployments"], [F.projects, "implementations"]]) {
      for (const key of Object.keys(FIELDS[area])) {
        for (const col of [snake(key), key]) assert.deepEqual(baseWords(wb.sheetColumnKey(sheet, col)), [], `${sheet} column ${col} reads ${wb.sheetColumnKey(sheet, col)}`);
      }
    }
    assert.equal(wb.sheetColumnKey(F.deliveries, "deployment_strategy"), keys.speakKey("deployment_id").replace(/_id$/, "_strategy"), "named as the model is given it");
    assert.equal(wb.sheetColumnKey(F.deliveries, "customer_id"), "company_id");
    assert.equal(wb.sheetColumnKey(F.deliveries, "notes"), "notes");
    assert.equal(wb.sheetColumnKey(F.platform, "deployment_model"), "deployment_model", "elsewhere speakKey's rule stands");
  });

  const errs = await imp("lib/ops-errors.ts");
  await check("6 an ops API error names the field in the profile's words (zod path) and speaks its prose", () => {
    const z = errs.errorText(zodIssue(["customerId"], "Required"));
    assert.equal(z, "companyId: Required");
    assert.deepEqual(baseWords(errs.zodMessage(zodIssue(["deployments", 0, "deploymentId"], "Required"))), []);
    const t = errs.errorText(new Error("No customer_id was given for this customer."));
    assert.deepEqual(baseWords(t), [], t);
    assert.match(errs.errorText('Customer "Acme Deployment Co" not found'), /"Acme Deployment Co"/, "quoted data stays as written");
  });

  const avail = await imp("lib/workflow-availability.ts");
  const lib = (await imp("agent/lib/workflow-library.generated.ts")).WORKFLOW_LIBRARY;
  const assign = lib.find((w) => w.name === "assign-account");
  await check("7 a base library row this workspace does not run is still listed, adoptable, in the profile's words, naming no specialist", () => {
    const row = avail.workflowForList({ id: "w", name: assign.name, description: assign.description, steps: assign.steps, script: assign.script });
    assert.equal(row.availability.available, false);
    assert.match(row.availability.reason, /Edit it to use this workspace's specialists and it becomes yours to run/);
    assert.deepEqual(baseWords(row.availability.reason), [], row.availability.reason);
    assert.deepEqual(baseWords(row.description), [], row.description);
    for (const s of row.steps) assert.deepEqual(baseWords(s), [], s);
  });
  await check("7 …and a row a person edited is returned exactly as stored", () => {
    const edited = { id: "w", name: assign.name, description: "mine: customer notes", steps: ["x"], script: assign.script + "\n// edited" };
    const row = avail.workflowForList(edited);
    assert.equal(row.description, edited.description);
    assert.equal(row.script, edited.script);
    // It still delegates to a specialist this workspace does not use, so it cannot run, and says so without naming
    // the specialist; edited to use the workspace's own, it can.
    assert.equal(row.availability.available, false);
    assert.match(row.availability.reason, /so it cannot run here\. Edit it to use this workspace's specialists/);
    assert.deepEqual(baseWords(row.availability.reason), [], row.availability.reason);
    const ours = avail.workflowForList({ ...edited, script: 'return await agent("x", { subagent: "research" });' });
    assert.equal(ours.availability.available, true);
    assert.equal(ours.script, 'return await agent("x", { subagent: "research" });');
  });
  await check("7 the row of a specialist this workspace does not use is listed as not part of it, naming no specialist", () => {
    const row = avail.workflowForList({ id: "s", name: "customer-context", description: "d", steps: [], script: null, trigger: "on delegation" });
    assert.equal(row.availability.available, false);
    assert.deepEqual(baseWords(row.availability.reason), [], row.availability.reason);
    assert.doesNotMatch(row.availability.reason, /customer-context/);
  });

  const exp = await imp("lib/record-export.ts");
  const BUNDLE = {
    type: "deployment",
    record: { id: "t1", title: "Chase the filing", containerType: "deployment", linkType: "customer", blockerOwner: "Customer", custom: { customer_tier: "gold" } },
    resolved: { deployment: { deploymentId: "d1", releaseStatus: "deployed" }, implementation: { blockerOwner: "Customer", implementationStage: "UAT" } },
    dataroom: { customerId: "acme", context: null, files: { "state.json": { type: "deployment" } } },
  };
  await check("2 an export a person copies shows CODE values in the profile's words (containerType, type, blockerOwner), JSON and Markdown", () => {
    const json = JSON.parse(exp.exportJson(BUNDLE));
    assert.notEqual(json.type, "deployment");
    const rec = json.record;
    assert.deepEqual(baseWords(JSON.stringify({ ...rec, custom: {} })), [], JSON.stringify(rec));
    const md = exp.bundleToMarkdown("T", BUNDLE).split("```json")[0];
    assert.deepEqual(baseWords(md.replace(/customer_tier/g, "")), [], md);
    assert.match(md, /Container Type:\*\* coverage report/i);
  });
  await check("2 …the data-room files it carries are stored DATA: values verbatim", () => {
    assert.equal(JSON.parse(exp.exportJson(BUNDLE)).dataroom.files["state.json"].type, "deployment");
  });
  await check("3 the profile's own custom fields are opaque: `custom` keys are never translated", () => {
    const out = JSON.parse(keys.jsonForPeople({ customerId: "a", custom: { customer_tier: "gold" } }));
    assert.equal(out.companyId, "a");
    assert.deepEqual(out.custom, { customer_tier: "gold" });
    assert.equal(JSON.parse(exp.exportJson(BUNDLE)).record.custom.customer_tier, "gold");
  });
  await check("4 errorMessage (the `e instanceof Error ? e.message : String(e)` answers) speaks, without the Error: prefix", () => {
    const m = errs.errorMessage(new Error("No customer_id was given for this deployment."));
    assert.deepEqual(baseWords(m), [], m);
    assert.doesNotMatch(m, /^Error:/);
  });
  await check("5 a base library original reads in the profile's words wherever it is served (list, detail, script versions), available or not", () => {
    for (const w of lib) {
      const row = avail.workflowForList({ id: "w", name: w.name, description: w.description, steps: w.steps, script: w.script });
      assert.deepEqual(baseWords(row.description), [], `${w.name}: ${row.description}`);
      // The script's prompts (its string literals) are product text; code (`args.customerId`) and a specialist's
      // directory name (delegated to by name) are not.
      const literals = [...avail.scriptForDisplay(w.script).matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1]).filter((t) => !/^[a-z0-9-]+$/.test(t));
      for (const t of literals) assert.deepEqual(baseWords(t), [], `${w.name}: ${t}`);
    }
  });
  await check("6 saving a library original's displayed script unchanged stores the original: the row is not 'edited'", () => {
    const shown = avail.workflowForList({ id: "w", name: assign.name, description: assign.description, steps: assign.steps, script: assign.script });
    assert.notEqual(shown.script, assign.script, "the editor shows the spoken script");
    const stored = avail.scriptToStore(shown.script);
    assert.equal(stored, assign.script);
    assert.equal(avail.workflowForList({ name: assign.name, script: stored }).availability.available, false);
    assert.equal(avail.scriptToStore(shown.script + "\n// mine"), shown.script + "\n// mine", "a real edit is kept");
  });

  const { domainView } = await imp("lib/profile-domains.ts");
  const { DEPLOYMENT_PROFILE } = await imp("lib/deployment-profile.generated.ts");
  await check("4c a pack that SHOWS an enum field without labelling it still never shows a stored base word (customer_cloud, customer-vpc, Customer)", () => {
    const domains = structuredClone(DEPLOYMENT_PROFILE.domains);
    domains.deployments.fields.cloudProvider = {};
    domains.deployments.fields.region = {};
    delete domains.implementations.fields.blockerOwner.options;
    for (const [area, key, value] of [["deployments", "cloudProvider", "customer_cloud"], ["deployments", "region", "customer-vpc"], ["implementations", "blockerOwner", "Customer"]]) {
      const view = domainView(area, domains);
      assert.deepEqual(baseWords(view.display(key, value)), [], `${key} ${value} -> ${view.display(key, value)}`);
      for (const o of view.options(key)) assert.deepEqual(baseWords(o.label), [], `${key} option ${o.value} -> ${o.label}`);
    }
  });

  const seed = await imp("lib/org-seed.ts");
  await check("10 a new workspace's built-in data-room README is in the profile's words: no base role or record word but the skills' real names", () => {
    // The fixture names its own seed; with none (dataroom.seed null) the built-in tree is written, in the profile's words.
    const builtIn = { ...DEPLOYMENT_PROFILE, dataroom: { ...DEPLOYMENT_PROFILE.dataroom, seed: null } };
    const files = seed.starterFiles("org-1", "Acme", builtIn);
    assert.deepEqual(files.map(([p]) => p), ["README.md", `${F.accounts}/README.md`, `${F.people}/README.md`]);
    for (const [path, body] of files) assert.doesNotMatch(body, ROLE_WORD, `${path} carries the base role word`);
    // A skill is called by its slug (`onboard-customer`), which does not move; nothing else may carry a base word.
    for (const [path, body] of files) assert.deepEqual(baseWords(body.replace(/\*\*onboard-customer\*\*/g, "")), [], `${path} carries a base word`);
    const all = files.map(([, b]) => b).join("\n");
    assert.match(all, /^Companies\/\{company_id\}\/$/m, "the tree shows the profile's folder and id");
    assert.match(all, /^Coverage-reports\/\{company_id\}\//m);
    assert.ok(!all.split("\n").some((line) => line.startsWith(`${F.tickets}/`)), "a record area the profile hides is not in the tree");
    assert.match(all, /^# Acme — data room$/m, "the workspace's own name is kept as it is");
    assert.match(all, /the agent and the analyst team/);
    assert.match(all, /curated by the analyst\n/);
    assert.match(all, /Analysts are recorded as team memories/);
    // And the seed this deployment actually writes (the profile's own).
    for (const [path, body] of seed.starterFiles("org-1", "Acme")) assert.doesNotMatch(body, ROLE_WORD, `${path} carries the base role word`);
  });
  await check("11 the published HTML reports label the account, its owner and the record areas in the profile's words", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    const render = await imp("agent/lib/render-html.ts");
    const html = await render.renderDataroomSummary({ now: "2026-07-10T12:00:00Z" });
    assert.doesNotMatch(html, ROLE_WORD);
    assert.deepEqual(baseWords(html), [], "the summary carries no base record word");
    assert.match(html, /<h2>Companies<\/h2>/);
    assert.match(html, /<th>Covering Analyst<\/th>/);
    assert.equal(render.ownerHeading(), "Covering Analyst");
  });
}

async function defaults() {
  console.log("default profile (this checkout):");
  const keys = await imp("lib/ui-keys.ts");
  await check("D JSON a person reads is byte-identical to JSON.stringify", () => {
    assert.equal(keys.jsonForPeople({ record: RECORD }, 2), JSON.stringify({ record: RECORD }, null, 2));
    assert.equal(keys.jsonForPeople(RECORD), JSON.stringify(RECORD));
  });
  await check("D speakKey is the identity; the owner key keeps its name and reads the profile's owner label", () => {
    for (const k of ["customer_id", "deployment_model", "deploymentId", "fdeOwner"]) assert.equal(keys.speakKey(k), k);
    assert.equal(keys.humanizeKey("fdeOwner"), "Account owner");
    assert.equal(keys.humanizeKey("fde_owner"), "Account owner");
    assert.equal(keys.humanizeKey("solutionFdeOwner"), "Solution account owner");
    assert.equal(keys.humanizeKey("solution_fde_owner"), "Solution account owner");
    assert.equal(keys.humanizeKey("accountOwner"), "Account owner", "the owner's neutral key reads the same label");
    assert.equal(keys.humanizeKey("solution_owner"), "Solution account owner");
    assert.equal(keys.humanizeKey("customerId"), "Customer Id");
  });
  await check("D the second owner's key reads the profile's label under both names, and its sheet column its neutral name", async () => {
    for (const k of ["aeOwner", "ae_owner", "secondaryOwner", "secondary_owner"]) assert.equal(keys.humanizeKey(k), "Secondary owner", k);
    for (const k of ["aeOwner", "ae_owner", "secondaryOwner"]) assert.equal(keys.speakKey(k), k, "the stored key itself never moves");
    const wbf = await imp("lib/workbook-fields.ts");
    assert.equal(wbf.sheetColumnKey(F.accounts, "ae_owner"), "secondary_owner");
    assert.equal(wbf.sheetColumnKey(F.accounts, "fde_owner"), "fde_owner");
    assert.equal(wbf.sheetColumnKey(F.accounts, "arr"), "arr");
    const ok = await imp("agent/lib/owner-keys.ts");
    assert.equal(ok.secondaryOwnerKeyLabel("ae_owner", "Relationship manager"), "Relationship manager", "the label is the profile's");
    assert.equal(ok.secondaryOwnerKeyLabel("businessOwnerEmail", "x"), null);
    assert.equal(ok.secondaryOwnerKeyLabel("fdeOwner", "x"), null);
    // account_fields.hidden: either key of an owner pair hides the field under both keys, here and for the model.
    const base = { domains: { deployments: {}, implementations: {} } };
    for (const named of ["aeOwner", "secondaryOwner"]) {
      const h = wbf.workbookHidden({ ...base, account_fields: { hidden: [named, "arr"] } });
      assert.deepEqual([...h.account].sort(), ["aeOwner", "arr", "secondaryOwner"], `hidden: ["${named}"]`);
    }
    assert.deepEqual([...wbf.workbookHidden({ ...base, account_fields: { hidden: ["accountOwner"] } }).account].sort(), ["accountOwner", "fdeOwner"]);
    assert.deepEqual([...wbf.workbookHidden({ ...base, account_fields: { hidden: ["arr"] } }).account], ["arr"], "no owner key is added when none is named");
    const av = await imp("agent/lib/agent-vocabulary.ts");
    for (const named of ["aeOwner", "secondaryOwner"]) {
      const h = av.hiddenFieldsOf({ ...base, account_fields: { hidden: [named] } });
      assert.ok(h.account.has("aeOwner") && h.account.has("secondaryOwner") && h.any, `the model's record loses the field when the profile hides "${named}"`);
      assert.deepEqual(av.pruneRecordWith(h, { id: "x", aeOwner: "a@b.co", tier: "Growth" }), { id: "x", tier: "Growth" });
    }
    assert.equal(av.hiddenFieldsOf({ ...base, account_fields: { hidden: [] } }).any, false);
  });
  const words = await imp("lib/ui-words.ts");
  await check("D a stored value that carries the member's legacy word stays as stored and reads the profile's member word", () => {
    assert.equal(words.storedValueLabel("ownerTeam", LEGACY_MEMBER.singular), "Member");
    assert.equal(words.storedValueLabel("valueEvidenceStatus", `${LEGACY_MEMBER.singular} Verified`), "Member Verified");
    assert.equal(words.storedValueLabel("ownerTeam", "Support"), "Support");
    assert.equal(words.storedValueLabel("valueEvidenceStatus", "Customer Verified"), "Customer Verified");
    assert.equal(words.storedValueLabel("note", `${LEGACY_MEMBER.singular} Verified`), `${LEGACY_MEMBER.singular} Verified`, "only the two enum fields");
    assert.equal(words.storedValueLabel("ownerTeam", undefined), undefined);
  });
  const errs = await imp("lib/ops-errors.ts");
  await check("D an ops API error reads exactly as before (`path: message`, String(e))", () => {
    assert.equal(errs.errorText(zodIssue(["customerId"], "Required")), "customerId: Required");
    assert.equal(errs.zodMessage(zodIssue([], "Invalid"), "query"), "query: Invalid");
    const e = new Error("No customer_id was given for this customer.");
    assert.equal(errs.errorText(e), String(e));
  });
  const avail = await imp("lib/workflow-availability.ts");
  // The default profile names no library (base code ships none): the rows are those of a deployment that opted into
  // the one in this repository, read as its build reads them.
  const { readLibrary } = await imp("scripts/lib/profile-library.mjs");
  const lib = readLibrary(ROOT, { "account-delivery": "library/account-delivery" }).workflows;
  await check("D the default profile itself provisions no library", async () => {
    const generated = await imp("agent/lib/workflow-library.generated.ts");
    assert.deepEqual([generated.WORKFLOW_LIBRARY.length, generated.RECIPE_LIBRARY.length, generated.LIBRARY_SOURCES.length], [0, 0, 0]);
  });
  await check("D every library row is available and returned as stored, its role placeholders in the profile's words", async () => {
    const { fill } = await imp("agent/lib/agent-vocabulary.ts");
    assert.equal(lib.length, 13);
    for (const w of lib) {
      const row = avail.workflowForList({ ...w }, undefined, lib);
      assert.equal(row.availability.available, true);
      assert.equal(row.description, fill(w.description));
      assert.doesNotMatch(row.description, /\{(member|members|owner)\}/i, w.name);
    }
    const assign = lib.find((w) => w.name === "assign-account");
    assert.match(assign.description, /\{owner\}/, "the library writes a placeholder, never a role word");
    assert.match(avail.workflowForList({ ...assign }, undefined, lib).description, /durable account owner/);
  });

  const exp = await imp("lib/record-export.ts");
  const B = { type: "deployment", record: { containerType: "deployment", blockerOwner: "Customer", fdeOwner: "a@x", custom: { customer_tier: "gold" } }, resolved: { comments: [{ author: "a", body: "b" }] }, dataroom: { customerId: "acme", context: "ctx", files: { "s.json": { type: "deployment" } } } };
  await check("D Copy as JSON is the API's bundle, a record kind in the profile's word; Markdown is the former rendering", () => {
    // A record kind (`type`, `containerType`) reads the profile's word for the record under every profile; where
    // that is the stored word the copy is byte-identical to the API's bundle. The data-room files are data.
    const spoken = { ...B, type: words.W.deployment, record: { ...B.record, containerType: words.W.deployment } };
    assert.equal(exp.exportJson(B), JSON.stringify(spoken, null, 2));
    const md = exp.bundleToMarkdown("T", B);
    assert.ok(md.includes(`- **Container Type:** ${words.W.deployment}`), md);
    assert.match(md, /- \*\*Account owner:\*\* a@x/);
    assert.match(md, /## Comments\n- Author: a · Body: b/);
    assert.match(md, /### S\.json\n```json\n\{\n  "type": "deployment"\n\}\n```/);
  });
  await check("D errorMessage is e.message, as before", () => assert.equal(errs.errorMessage(new Error("No customer_id")), "No customer_id"));
  await check("D saving a script is storing it", () => {
    for (const w of lib) assert.equal(avail.scriptToStore(w.script, undefined, lib), w.script);
  });
  await check("4 no ops route answers `e instanceof Error ? e.message : String(e)` unspoken", () => {
    const hits = spawnSync("grep", ["-rnE", "(\\w+) instanceof Error \\? \\1\\.message : String\\(\\1\\)", "app/api"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
    assert.equal(hits, "", hits);
  });
  await check("5 the workflow detail and script-version routes serve a library original as the list does", () => {
    assert.match(readFileSync(join(ROOT, "app/api/ops/workflows/[id]/route.ts"), "utf8"), /workflowForList\(item\)/);
    assert.match(readFileSync(join(ROOT, "app/api/ops/workflows/[id]/route.ts"), "utf8"), /scriptToStore\(patch\.script\)/);
    assert.match(readFileSync(join(ROOT, "app/api/ops/workflows/[id]/versions/route.ts"), "utf8"), /scriptForDisplay\(/);
  });

  await check("K the dataflow rule catches the control and is known to miss the reviewer's nine probes (known-miss fixture)", () => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/check-ui-vocabulary.mjs", "--scan-file", "scripts/fixtures/ui-vocabulary/known-miss/probe.tsx"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const caught = JSON.parse(r.stdout.trim().split("\n").pop()).map((h) => h.line);
    // CONTROL (line 29) is caught. Lines 7 (P1 record), 8 (P2 return), 9 (P4 .map, LIST[i] in a template, a joined
    // array), 13 (P5 String()), 14 (P6 Map), 19 (P3 prop) are the known misses: move a line into `caught` when the rule
    // learns its route.
    assert.deepEqual([...new Set(caught)].sort((a, b) => a - b), [29]);
  });

  const seed = await imp("lib/org-seed.ts");
  await check("D a new workspace's built-in data-room README reads as before, in the default profile's member word", async () => {
    // With the member's LEGACY words put back (what the default profile said before it spoke neutrally), the tree is
    // byte-identical to the one before it took the profile's words (sha256 of the pre-change output, aaec6b9); the
    // default profile's tree differs from that in the member word alone.
    const { createHash } = await import("node:crypto");
    const { DEPLOYMENT_PROFILE } = await imp("lib/deployment-profile.generated.ts");
    // The pre-change tree called the account by its STORED name too, so that is put back with the member's words:
    // the README takes both from the profile, and neither is a literal in lib/org-seed.ts.
    const storedAccount = { singular: STORED_RECORDS.account[0], plural: STORED_RECORDS.account[1] };
    // …and it wrote its files under the folder names of that time, which were part of the code then and are a
    // profile's now: the pin a deployment that already holds files carries (scripts/fixtures/dataroom-folders) puts
    // them back, so the same hash also proves a PINNED deployment's starter tree is the one it always was, path
    // for path and byte for byte.
    const pin = JSON.parse(readFileSync(join(new URL("..", import.meta.url).pathname, "scripts/fixtures/dataroom-folders/50-legacy-folders.json"), "utf8")).dataroom;
    const pinnedRoom = { ...DEPLOYMENT_PROFILE.dataroom, uploads_folder: pin.uploads_folder, domains: Object.fromEntries(Object.entries(DEPLOYMENT_PROFILE.dataroom.domains).map(([id, d]) => [id, { ...d, folder: pin.domains[id].folder, label: pin.domains[id].folder }])) };
    const legacy = { ...DEPLOYMENT_PROFILE, dataroom: pinnedRoom, vocabulary: { ...DEPLOYMENT_PROFILE.vocabulary, account: storedAccount, member: { singular: LEGACY_MEMBER.singular, plural: LEGACY_MEMBER.plural }, owner: LEGACY_MEMBER.owner } };
    const before = seed.starterFiles("org-1", "Acme", legacy);
    // The pre-change tree spelled the account two ways, its stored name in most sentences and "account" in three.
    // Every one is the profile's word now, so those three are put back as they were written before the hash is taken.
    const [one] = STORED_RECORDS.account;
    const asWritten = (t) => t.replace(`${one} context, curated by`, "account context, curated by").replace(`know about this ${one} lives`, "know about this account lives").replace(`when asked about a ${one}.`, "when asked about an account.");
    assert.equal(createHash("sha256").update(JSON.stringify(before.map(([p, body]) => [p, asWritten(body)]))).digest("hex"), "991a1d36007cec5dc527d98e6619d68f11b216f61a783ad4963e585744bb81fb");
    assert.notDeepEqual(before.map(([, body]) => asWritten(body)), before.map(([, body]) => body), "the three sentences do take the profile's word");
    const swap = (t) => t.replace(new RegExp(`\\b${LEGACY_MEMBER.plural}\\b`, "g"), "Members").replace(new RegExp(`\\b${LEGACY_MEMBER.singular}\\b`, "g"), "member");
    const storedAccountDefault = { ...DEPLOYMENT_PROFILE, dataroom: pinnedRoom, vocabulary: { ...DEPLOYMENT_PROFILE.vocabulary, account: storedAccount } };
    assert.deepEqual(seed.starterFiles("org-1", "Acme", storedAccountDefault), before.map(([p, body]) => [p, swap(body)]));
    const files = Object.fromEntries(seed.starterFiles("org-1", "Acme"));
    for (const [path, body] of Object.entries(files)) assert.doesNotMatch(body, ROLE_WORD, `${path} carries the legacy role word`);
    assert.deepEqual(Object.keys(files), ["README.md", `${F.accounts}/README.md`, `${F.people}/README.md`]);
    assert.ok(files["README.md"].includes(`Everything the agent and the ${BASE_MEMBER} team\nknow about this ${words.W.account} lives here`));
    assert.ok(files["README.md"].includes(`${words.W.account} context, curated by the ${BASE_MEMBER}\n`));
    assert.ok(files[`${F.people}/README.md`].includes(`Internal staff do **not** belong here. ${BASE_MEMBERS.charAt(0).toUpperCase() + BASE_MEMBERS.slice(1)} are recorded as team memories via the\n`));
  });
  await check("D the published HTML reports keep the base owner heading", async () => {
    const render = await imp("agent/lib/render-html.ts");
    assert.equal(render.ownerHeading(), BASE_VOCAB.owner.replace(/\bowner\b/, "Owner"));
  });
}

/**
 * R: the RECORD words a person reads, under the profile this checkout (or stamped copy) carries. Written against the
 * profile's own words (`W`), so it holds under the default profile whatever its words are, under the relabelled
 * fixture and under the neutral one. `relabels`: the profile calls at least one record by a word that is not its
 * stored name, so the stored name must not be read anywhere.
 */
async function records(name) {
  console.log(`\nrecord words (${name}):`);
  const { W, an, domainLabel } = await imp("lib/ui-words.ts");
  const keys = await imp("lib/ui-keys.ts");
  const title = (w) => String(w).replace(/(^|\s)([a-z])/g, (_m, sp, c) => sp + c.toUpperCase());
  /** The stored names this profile does NOT use for its records: the ones no person may read. */
  const unused = Object.entries(STORED_RECORDS).flatMap(([k, [one, many]]) => [W[k] === one ? [] : one, W[`${k}s`] === many ? [] : many]).flat();
  const stray = (text) => recordProseWords(text).filter((w) => unused.includes(w.toLowerCase()));
  /** A data-room FOLDER named in a sentence reads its profile label; where the profile keeps the stored folder name
   *  ("Deployments"), that name is the folder's and is put aside before the sentence is read. */
  const folders = ["accounts", "deliveries", "projects"].map((d) => domainLabel(d));
  const besideFolders = (text) => folders.reduce((t, f) => t.replaceAll(f, " "), String(text));
  console.log(`  (the profile's words: ${W.account} / ${W.deployment} / ${W.implementation} / ${W.rollout}; stored names it does not use: ${unused.join(", ") || "none"})`);

  await check("R1 a product key made into a LABEL reads the profile's word for the record, a key shown as a key keeps its rule", () => {
    assert.equal(keys.keyLabel("customerId"), `${title(W.account)} Id`);
    assert.equal(keys.keyLabel("deploymentId"), `${title(W.deployment)} Id`);
    assert.equal(keys.keyLabel("implementationStage"), `${title(W.implementation)} Stage`);
    assert.equal(keys.keyLabel("rolloutId"), `${title(W.rollout)} Id`);
    assert.equal(keys.keyLabel("deployment"), title(W.deployment), "an export's section heading");
    assert.equal(keys.keyLabel("implementation"), title(W.implementation));
    assert.equal(keys.keyLabel("deploymentModel"), "Deployment Model", "a platform's software-deployment setting is not the record");
    assert.equal(keys.keyLabel("notes"), "Notes");
    assert.equal(keys.keyLabel("fdeOwner"), W.owner);
    for (const k of ["customerId", "customers", "deploymentId", "deploymentIds", "relatedDeploymentIds", "implementationStage", "implementationRiskLevel", "rolloutId"]) {
      assert.deepEqual(recordTokens(keys.keyLabel(k)).filter((w) => unused.includes(w.toLowerCase())), [], `${k} reads ${keys.keyLabel(k)}`);
    }
  });
  await check("R2 a table preview's column header reads the profile's word for a product KEY, and leaves a file's own header alone", () => {
    assert.equal(keys.headerLabel("customer_id"), `${title(W.account)} ID`);
    assert.equal(keys.headerLabel("customerId"), `${title(W.account)} ID`);
    assert.equal(keys.headerLabel("deployment_id"), `${title(W.deployment)} ID`);
    assert.equal(keys.headerLabel("implementation_stage"), `${title(W.implementation)} Stage`);
    assert.equal(keys.headerLabel("fde_owner"), W.owner);
    assert.equal(keys.headerLabel("ae_owner"), W.secondaryOwner, "the second owner's column reads the profile's label");
    assert.equal(keys.headerLabel("secondaryOwner"), W.secondaryOwner);
    assert.equal(keys.headerLabel("deployment_model"), "Deployment Model");
    // Not key-shaped: the file's own words. They are data, shown as written (case tidied as before).
    assert.equal(keys.headerLabel("Customer"), "Customer");
    assert.equal(keys.headerLabel("Net revenue"), "Net Revenue");
    assert.equal(keys.headerLabel("arr_usd"), "ARR Usd");
    assert.equal(keys.headerLabel(""), "");
    // A word that is also an Object.prototype property is a word like any other.
    assert.equal(keys.headerLabel("constructor"), "Constructor");
    assert.equal(keys.headerLabel("customer_constructor"), `${title(W.account)} Constructor`);
    assert.equal(keys.keyLabel("customerToString"), `${title(W.account)} To String`);
  });
  const exp = await imp("lib/record-export.ts");
  await check("R3 a record kind reads the profile's word wherever a person copies it (JSON and Markdown); data stays data", () => {
    assert.equal(keys.speakValue("containerType", "deployment"), W.deployment);
    assert.equal(keys.speakValue("containerType", "implementation"), W.implementation);
    assert.equal(keys.speakValue("linkType", "customer"), W.account);
    assert.equal(keys.speakValue("type", "constructor"), "constructor", "an inherited property name is not a kind");
    assert.equal(keys.speakValue("note", "deployment"), "deployment", "any other field's value is data");
    const bundle = {
      type: "deployment",
      record: { id: "t1", title: "Chase the filing", customerId: "acme", containerType: "implementation", linkType: "customer", note: "the customer asked" },
      resolved: { deployment: { deploymentId: "d1" }, implementation: { implementationProgressPct: 40 } },
      dataroom: { customerId: "acme", context: null, files: { "state.json": { type: "deployment" } } },
    };
    const json = JSON.parse(exp.exportJson(bundle));
    assert.equal(json.type, W.deployment);
    assert.equal(json.record.containerType, W.implementation);
    assert.equal(json.record.linkType, W.account);
    assert.equal(json.record.note, "the customer asked", "a value is data");
    assert.equal(json.dataroom.files["state.json"].type, "deployment", "a data-room file is stored data");
    const md = exp.bundleToMarkdown("T", bundle).split("```json")[0];
    assert.ok(md.includes(`- **${title(W.account)} Id:** acme`), md);
    assert.ok(md.includes(`- **Container Type:** ${W.implementation}`), md);
    assert.ok(md.includes(`## ${title(W.deployment)}\n- **${title(W.deployment)} Id:** d1`), md);
    assert.ok(md.includes(`## ${title(W.implementation)}\n- **${title(W.implementation)} Progress Pct:** 40`), md);
    assert.deepEqual(stray(md.replace("the customer asked", "")), [], md);
  });

  const delegate = await imp("lib/workflow-delegate.ts");
  await check("R4 a workflow step's framing names the account in the profile's word", () => {
    const ctx = { workflow: "Weekly report", phase: "Gather", runId: "wfr_1", call: 2, customerId: "acme-bank" };
    const plain = delegate.composeStepMessage("Summarise last week's tickets.", undefined, ctx);
    assert.ok(plain.includes(`${W.Account}: acme-bank`), plain);
    const routed = delegate.composeStepMessage("Summarise last week's tickets.", "research", ctx);
    assert.ok(routed.includes(`which run and ${W.account} this is for`), routed);
    for (const m of [plain, routed]) assert.deepEqual(stray(m), [], m);
  });

  const seed = await imp("lib/org-seed.ts");
  const { DEPLOYMENT_PROFILE } = await imp("lib/deployment-profile.generated.ts");
  await check("R5 a new workspace's built-in README names the account in the profile's word, in every sentence", () => {
    const builtIn = { ...DEPLOYMENT_PROFILE, dataroom: { ...DEPLOYMENT_PROFILE.dataroom, seed: null } };
    const files = Object.fromEntries(seed.starterFiles("org-1", "Acme", builtIn));
    const accounts = files[`${F.accounts}/README.md`];
    assert.ok(accounts.startsWith(`# ${W.Accounts}\n`), accounts.slice(0, 40));
    assert.ok(accounts.includes(`One subtree per ${W.account}, keyed by`), accounts);
    assert.ok(files["README.md"].includes(`1. Never write ${W.account} content outside its own`), files["README.md"]);
    assert.ok(files["README.md"].includes(`skill to create your first ${W.account} subtree.`), files["README.md"]);
    assert.ok(files[`${F.people}/README.md`].includes(`External people only — ${W.account} stakeholders, champions`), files[`${F.people}/README.md`]);
    assert.ok(files[`${F.people}/README.md`].includes(`keeps employee records out of ${W.account}-shared\ncontext.`), files[`${F.people}/README.md`]);
    assert.ok(files["README.md"].includes(`${W.account} context, curated by the ${W.member}\n`), files["README.md"]);
    assert.ok(files["README.md"].includes(`know about this ${W.account} lives here as plain files.`), files["README.md"]);
    assert.ok(accounts.includes(`reads first when asked about ${an(W.account)} ${W.account}.`), "a / an follows the word");
    // The skill is called by its slug, which does not move; nothing else may spell a stored name the profile does not use.
    for (const [path, body] of Object.entries(files)) assert.deepEqual(stray(body.replace(/\*\*onboard-customer\*\*/g, "")), [], `${path}:\n${body}`);
  });

  /** A seeder's `--print`: what it would write, as JSON, with no store and no database. */
  const printed = (script) => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, "--print"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, BLOB_READ_WRITE_TOKEN: "", DATABASE_URL: "", POSTGRES_URL: "", SEED_ORG: "" } });
    assert.equal(r.status, 0, `${script} --print: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  await check("R6 the sample data room the seeder writes names the records in the profile's words: no stored name in a sentence", () => {
    const files = printed("scripts/seed-dataroom-blob.mjs");
    assert.ok(Object.keys(files).length >= 30, "the tree is printed whole");
    for (const [path, body] of Object.entries(files)) {
      assert.doesNotMatch(body, /undefined|\$\{|\{(account|deployment|implementation|rollout)s?\}/i, `${path} carries an unfilled word`);
      // `stage: "implementation"` is a pipeline's stored stage value in a JSON file; everything else is a sentence.
      assert.deepEqual(stray(besideFolders(body.replace(/"stage": "implementation"/, ""))), [], `${path}:\n${body}`);
    }
    const all = Object.values(files).join("\n");
    assert.ok(all.includes(`requested by ${W.account} infosec`), "the account, mid-sentence");
    assert.ok(all.includes(`# Acme Bank — ${W.Account} Context\n`), "a file's own heading");
    assert.ok(all.includes(`first — the ${W.account} is sensitive to surprise emails.`));
    assert.ok(all.includes(`- Owns migration execution for assigned ${W.accounts} (approach docs`), "the plural");
    assert.ok(all.includes(`# Signoff — ${W.Account} Infrastructure (Acme Bank)`), "the account, in a heading");
    assert.ok(all.includes(`- ${W.Account}-managed KMS keys for data at rest`));
    assert.ok(all.includes(`playbook for migrating ${an(W.account)} ${W.account}'s collections history`), "a / an follows the word");
    assert.ok(all.includes(`- ${W.Implementation} kicked off 2026-06-02`));
    assert.ok(all.includes(`**Stage:** ${W.implementation} ·`));
    assert.ok(all.includes(`accountable for the v2.4.0 ${W.deployment} health`));
    assert.ok(all.includes(`${W.deployment}-specific overrides live under ${domainLabel("deliveries")}.`), "a folder reads its profile label");
  });
  await check("R7 the connector and workflow rows the ops seeder writes name the records and folders in the profile's words", () => {
    const { CONNECTORS, WORKFLOWS } = printed("scripts/seed-ops.mjs");
    const sor = CONNECTORS.find((c) => c.kind === "system_of_record");
    assert.equal(sor.detail, `Neon Postgres — ${W.accounts}, tickets, ${W.deployments}, interactions`);
    assert.equal(sor.lands, `Postgres (Drizzle) · mirrored to ${domainLabel("accounts")}/{id}/interactions.jsonl`);
    assert.deepEqual(sor.synced, [W.Accounts, domainLabel("people"), "Workbook sheets"]);
    const slack = CONNECTORS.find((c) => c.kind === "slack");
    assert.equal(slack.detail, `${W.Account} channels & alerts via Vercel Connect`);
    assert.ok(slack.synced.includes(`${W.Account} DMs`));
    assert.equal(WORKFLOWS.find((w) => w.name === "deployment").description, `Deploy & operate ${W.account} platforms; owns the 4-party infra signoff chain.`);
    assert.equal(WORKFLOWS.find((w) => w.name === "research").description, `Research ${an(W.account)} ${W.account} & build its 7 domain workbooks.`, "a / an follows the word");
    // What a person reads in a row: its detail, where it lands, what it syncs, a workflow's description. Vercel's
    // row lists what VERCEL syncs under Vercel's own name for it ("Deployments", as on the connector card); a row's
    // name and kind are identifiers.
    for (const c of CONNECTORS) for (const t of [c.detail, ...c.synced.filter((x) => c.kind !== "vercel" || x !== "Deployments")]) assert.deepEqual(stray(besideFolders(t)), [], `${c.name}: ${t}`);
    for (const w of WORKFLOWS) assert.deepEqual(stray(w.description), [], `${w.name}: ${w.description}`);
    assert.equal(slack.lands, `${domainLabel("accounts")}/·/${domainLabel("tickets")}/·/${domainLabel("people")}/syncs/slack`, "a folder reads its profile label");
  });
  const secrets = await imp("lib/connector-secrets-manifest.ts");
  const { SUBAGENT_META } = await imp("app/_components/subagent-meta.generated.ts");
  await check("R8 a connector's secret notes name a specialist by its display name, never by its directory name", () => {
    const granola = secrets.CONNECTOR_SECRETS.granola.find((x) => x.name === "GRANOLA_API_KEY").purpose;
    const readers = ["research", "customer-context"].filter((k) => k in SUBAGENT_META).map((k) => SUBAGENT_META[k].name);
    assert.equal(granola, `Meeting notes. Without it, ${readers.join(" and ") || "the specialists"} lose their call transcripts.`);
    // A specialist's display name is the roster's (scripts/gen-subagent-meta.mjs): the note repeats it and adds no
    // record word of its own.
    for (const x of Object.values(secrets.CONNECTOR_SECRETS).flat()) {
      assert.doesNotMatch(x.purpose, /\b[a-z]+-context\b/, `${x.name}: ${x.purpose}`);
      assert.deepEqual(stray(readers.reduce((t, name) => t.replaceAll(name, " "), x.purpose)), [], `${x.name}: ${x.purpose}`);
    }
  });
  const { domainView } = await imp("lib/profile-domains.ts");
  const { DOMAIN_FIELDS } = await imp("lib/deployment-profile.generated.ts");
  await check("R9 an enum value the profile gives no label reads the profile's word for the record it names (a choice's label, a cell)", () => {
    let seen = 0;
    for (const area of ["deployments", "implementations"]) {
      const view = domainView(area);
      for (const [key, meta] of Object.entries(DOMAIN_FIELDS[area])) {
        if (meta.type !== "enum") continue;
        for (const [value, label] of [...(meta.values ?? []).map((x) => [x, view.display(key, x)]), ...view.options(key).map((o) => [o.value, o.label])]) {
          seen++;
          assert.deepEqual(recordTokens(label).filter((w) => unused.includes(w.toLowerCase())), [], `${area}.${key}: ${value} reads ${label}`);
        }
      }
    }
    assert.ok(seen > 40, "the enum fields were read");
    // The stored values are what they were: the label is what a person reads, the value is what is submitted.
    assert.ok(DOMAIN_FIELDS.implementations.blockerOwner.values.includes(`${STORED_RECORDS.account[0][0].toUpperCase()}${STORED_RECORDS.account[0].slice(1)}`));
    assert.ok(DOMAIN_FIELDS.deployments.region.values.includes(`${STORED_RECORDS.account[0]}-vpc`));
  });
  await check("R10 the roster names no specialist by a record's stored name: a directory name is not a display name", () => {
    assert.ok(Object.keys(SUBAGENT_META).length >= 4, "the roster was generated");
    for (const [key, m] of Object.entries(SUBAGENT_META)) {
      assert.doesNotMatch(m.name, /[{}]/, `${key}: an unfilled placeholder in ${m.name}`);
      assert.deepEqual(recordTokens(m.name).filter((w) => unused.includes(w.toLowerCase())), [], `${key} is shown as ${m.name}`);
    }
    if (SUBAGENT_META["customer-context"]) assert.equal(SUBAGENT_META["customer-context"].name, `${W.Account} Context`);
    if (SUBAGENT_META.deployment) assert.equal(SUBAGENT_META.deployment.name, W.Deployment);
  });
}

/** R0: the static half, in this checkout only (a stamped copy carries no app/). */
async function recordLiterals() {
  console.log("\nrecord-word audit (every string literal of app/, components/, lib/ and the seeders):");
  await check("R0 the audit reports each shape that used to reach a person, and no contract (control fixture)", () => {
    const probe = "scripts/fixtures/ui-vocabulary/record-literals/probe.ts";
    const { literals } = auditRecordLiterals(ROOT, { targets: [probe], shared: null, own: null });
    const src = readFileSync(join(ROOT, probe), "utf8").split("\n");
    const want = src.flatMap((line, i) => Array.from(line.matchAll(/\bLEAK\b/g), () => i + 1));
    assert.ok(src.some((line) => /CONTRACT/.test(line)), "the control fixture marks its contracts");
    assert.ok(want.length >= 8, "the control fixture marks its leaks");
    assert.deepEqual(literals.filter((l) => l.kind === "prose").map((l) => l.line).sort((a, b) => a - b), want);
    for (const l of literals) assert.doesNotMatch(src[l.line - 1], /CONTRACT/, `reported a contract: ${l.text}`);
    // The default profile's own words (read from profiles/00-default.json) are profile words too: in a sentence, or
    // alone as a label, they are reported; an identifier or a word the profile supplies is not.
    const wantDefault = src.flatMap((line, i) => Array.from(line.matchAll(/\bDEFAULT\b/g), () => i + 1));
    assert.ok(wantDefault.length >= 3, "the control fixture marks the default profile's words");
    assert.deepEqual(literals.filter((l) => l.kind === "default").map((l) => l.line).sort((a, b) => a - b), wantDefault);
  });
  await check("R0 no literal spells a record word as prose, and every token that carries one is a listed contract", () => {
    const { literals, unused } = auditRecordLiterals(ROOT);
    const bad = literals.filter((l) => !l.allowed);
    assert.deepEqual(bad.map((l) => `${l.source}:${l.line} [${l.kind}] ${JSON.stringify(l.text.slice(0, 120))}`), [], "take the word from the profile (W in lib/ui-words.ts), or list the contract in scripts/fixtures/ui-vocabulary/record-literals.allow.json with why");
    assert.deepEqual(unused, [], "an allowance that matches nothing is stale");
    assert.ok(literals.length > 100, "the audit read the tree");
    assert.ok(literals.some((l) => l.source === "agent/lib/render-html.ts"), "the report renderer is read");
  });
}

/** 8: gen-deployment-profile while an eve build moves the excluded specialists aside and back. */
async function concurrentBuild() {
  console.log("\nprofile generator during an eve build (8):");
  // Removed on every way out, SIGINT and SIGTERM included (mold_v1-188).
  const { dir, remove } = scratchDir("ui-vocab-race-");
  try {
    for (const e of ["scripts", "profiles", "lib", "agent"]) cpSync(join(ROOT, e), join(dir, e), { recursive: true, filter: (s) => !s.includes("__pycache__") });
    cpSync(FIXTURE, join(dir, "profiles/50-relabelled.json"));
    const excluded = JSON.parse(readFileSync(FIXTURE, "utf8")).specialists.exclude;
    // A build's own moves, as fast as they go: each excluded directory between agent/subagents and the hidden folder.
    mkdirSync(join(dir, ".eve-build-hidden/subagents"), { recursive: true });
    const mover = spawn(process.execPath, ["-e", `
      const { renameSync } = require("node:fs"); const { join } = require("node:path");
      const d = ${JSON.stringify(dir)}, ks = ${JSON.stringify(excluded)};
      const a = (k) => join(d, "agent/subagents", k), b = (k) => join(d, ".eve-build-hidden/subagents", k);
      for (;;) { for (const k of ks) { try { renameSync(a(k), b(k)); } catch {} } for (const k of ks) { try { renameSync(b(k), a(k)); } catch {} } }
    `], { stdio: "ignore" });
    let failures = 0;
    const runs = 150;
    try {
      for (let i = 0; i < runs; i++) {
        const r = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--check"], { cwd: dir, encoding: "utf8" });
        if (r.status !== 0) failures++;
      }
    } finally {
      mover.kill("SIGKILL");
    }
    await check(`8 no run of ${runs} refuses an excluded specialist a build has moved aside (failures: ${failures})`, () => assert.equal(failures, 0));
  } finally {
    remove();
  }
}

if (STAMPED) {
  if (!RECORDS_ONLY) await relabelled();
  await records(RECORDS_ONLY ? "the neutral-records fixture" : "the relabelled fixture");
} else {
  await defaults();
  await records("default profile");
  await recordLiterals();
  // STAMPED: a copy stamped with a fixture profile, this file re-run inside it. The relabelled fixture runs every
  // relabelled check and the record checks; the neutral-records fixture the record checks alone.
  for (const [fixture, flags] of [[FIXTURE, []], [NEUTRAL_FIXTURE, ["--records-only"]]]) {
    const { dir, remove } = scratchDir("ui-vocab-stamped-");
    try {
      for (const e of ["agent", "lib", "data", "scripts", "library", "profiles", "package.json", "dm.md", "docs"]) if (existsSync(join(ROOT, e))) cpSync(join(ROOT, e), join(dir, e), { recursive: true, filter: (s) => !s.includes("__pycache__") });
      mkdirSync(join(dir, "app/_components"), { recursive: true });
      cpSync(fixture, join(dir, "profiles/50-relabelled.json"));
      // The stamped deployment opts into a workflow library (base code ships none), so the rows a person is shown
      // for one are still checked in the profile's words.
      cpSync(join(ROOT, "library/account-delivery/profile.json"), join(dir, "profiles/40-library-account-delivery.json"));
      symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
      for (const s of ["scripts/gen-subagent-meta.mjs", "scripts/gen-deployment-profile.mjs", "scripts/build-workflow-library.mjs"]) {
        const r = spawnSync(process.execPath, [s], { cwd: dir, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${s}: ${r.stderr}`);
      }
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/test-ui-vocabulary.mjs", "--stamped", ...flags], { cwd: dir, encoding: "utf8", stdio: "inherit" });
      if (r.status !== 0) process.exitCode = 1;
    } finally {
      remove();
    }
  }
  await concurrentBuild();
}
if (!STAMPED) console.log(process.exitCode ? "\nui vocabulary: SOME CHECKS FAILED" : "\nui vocabulary: every check passed");
