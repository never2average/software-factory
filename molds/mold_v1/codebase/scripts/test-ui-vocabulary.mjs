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
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
const FIXTURE = join(new URL("..", import.meta.url).pathname, "scripts/fixtures/agent-vocabulary/50-relabelled.json");
const { LEGACY_MEMBER } = await import(pathToFileURL(join(process.cwd(), "agent/lib/legacy-member.ts")).href);
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
  });

  const wb = await imp("lib/workbook-fields.ts");
  const { DOMAIN_FIELDS: FIELDS } = await imp("lib/deployment-profile.generated.ts");
  await check("9b a record area's OWN sheet names each of its columns in the profile's words, deployment_strategy included (review of #62)", () => {
    const snake = (k) => k.replace(/([A-Z])/g, "_$1").toLowerCase();
    for (const [sheet, area] of [["Deployments", "deployments"], ["Implementation", "implementations"]]) {
      for (const key of Object.keys(FIELDS[area])) {
        for (const col of [snake(key), key]) assert.deepEqual(baseWords(wb.sheetColumnKey(sheet, col)), [], `${sheet} column ${col} reads ${wb.sheetColumnKey(sheet, col)}`);
      }
    }
    assert.equal(wb.sheetColumnKey("Deployments", "deployment_strategy"), keys.speakKey("deployment_id").replace(/_id$/, "_strategy"), "named as the model is given it");
    assert.equal(wb.sheetColumnKey("Deployments", "customer_id"), "company_id");
    assert.equal(wb.sheetColumnKey("Deployments", "notes"), "notes");
    assert.equal(wb.sheetColumnKey("Platform", "deployment_model"), "deployment_model", "elsewhere speakKey's rule stands");
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
    assert.equal(row.availability.available, true);
    assert.equal(row.description, edited.description);
    assert.equal(row.script, edited.script);
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
    assert.deepEqual(files.map(([p]) => p), ["README.md", "Customers/README.md", "People/README.md"]);
    for (const [path, body] of files) assert.doesNotMatch(body, ROLE_WORD, `${path} carries the base role word`);
    // A skill is called by its slug (`onboard-customer`), which does not move; nothing else may carry a base word.
    for (const [path, body] of files) assert.deepEqual(baseWords(body.replace(/\*\*onboard-customer\*\*/g, "")), [], `${path} carries a base word`);
    const all = files.map(([, b]) => b).join("\n");
    assert.match(all, /^Companies\/\{company_id\}\/$/m, "the tree shows the profile's folder and id");
    assert.match(all, /^Coverage-reports\/\{company_id\}\//m);
    assert.doesNotMatch(all, /^Tickets\//m, "a record area the profile hides is not in the tree");
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
  const lib = (await imp("agent/lib/workflow-library.generated.ts")).WORKFLOW_LIBRARY;
  await check("D every library row is available and returned as stored, its role placeholders in the profile's words", async () => {
    const { fill } = await imp("agent/lib/agent-vocabulary.ts");
    for (const w of lib) {
      const row = avail.workflowForList({ ...w });
      assert.equal(row.availability.available, true);
      assert.equal(row.description, fill(w.description));
      assert.doesNotMatch(row.description, /\{(member|members|owner)\}/i, w.name);
    }
    const assign = lib.find((w) => w.name === "assign-account");
    assert.match(assign.description, /\{owner\}/, "the library writes a placeholder, never a role word");
    assert.match(avail.workflowForList({ ...assign }).description, /durable account owner/);
  });

  const exp = await imp("lib/record-export.ts");
  const B = { type: "deployment", record: { containerType: "deployment", blockerOwner: "Customer", fdeOwner: "a@x", custom: { customer_tier: "gold" } }, resolved: { comments: [{ author: "a", body: "b" }] }, dataroom: { customerId: "acme", context: "ctx", files: { "s.json": { type: "deployment" } } } };
  await check("D Copy as JSON is byte-identical to the API's bundle; Markdown to the former rendering", () => {
    assert.equal(exp.exportJson(B), JSON.stringify(B, null, 2));
    const md = exp.bundleToMarkdown("T", B);
    assert.match(md, /- \*\*Container Type:\*\* deployment/);
    assert.match(md, /- \*\*Account owner:\*\* a@x/);
    assert.match(md, /## Comments\n- Author: a · Body: b/);
    assert.match(md, /### S\.json\n```json\n\{\n  "type": "deployment"\n\}\n```/);
  });
  await check("D errorMessage is e.message, as before", () => assert.equal(errs.errorMessage(new Error("No customer_id")), "No customer_id"));
  await check("D saving a script is storing it", () => {
    for (const w of lib) assert.equal(avail.scriptToStore(w.script), w.script);
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
    const legacy = { ...DEPLOYMENT_PROFILE, vocabulary: { ...DEPLOYMENT_PROFILE.vocabulary, member: { singular: LEGACY_MEMBER.singular, plural: LEGACY_MEMBER.plural }, owner: LEGACY_MEMBER.owner } };
    const before = seed.starterFiles("org-1", "Acme", legacy);
    assert.equal(createHash("sha256").update(JSON.stringify(before)).digest("hex"), "991a1d36007cec5dc527d98e6619d68f11b216f61a783ad4963e585744bb81fb");
    const swap = (t) => t.replace(new RegExp(`\\b${LEGACY_MEMBER.plural}\\b`, "g"), "Members").replace(new RegExp(`\\b${LEGACY_MEMBER.singular}\\b`, "g"), "member");
    assert.deepEqual(seed.starterFiles("org-1", "Acme"), before.map(([p, body]) => [p, swap(body)]));
    const files = Object.fromEntries(seed.starterFiles("org-1", "Acme"));
    for (const [path, body] of Object.entries(files)) assert.doesNotMatch(body, ROLE_WORD, `${path} carries the legacy role word`);
    assert.deepEqual(Object.keys(files), ["README.md", "Customers/README.md", "People/README.md"]);
    assert.ok(files["README.md"].includes(`Everything the agent and the ${BASE_MEMBER} team\nknow about this account`));
    assert.ok(files["README.md"].includes(`account context, curated by the ${BASE_MEMBER}\n`));
    assert.ok(files["People/README.md"].includes(`Internal staff do **not** belong here. ${BASE_MEMBERS.charAt(0).toUpperCase() + BASE_MEMBERS.slice(1)} are recorded as team memories via the\n`));
  });
  await check("D the published HTML reports keep the base owner heading", async () => {
    const render = await imp("agent/lib/render-html.ts");
    assert.equal(render.ownerHeading(), BASE_VOCAB.owner.replace(/\bowner\b/, "Owner"));
  });
}

/** 8: gen-deployment-profile while an eve build moves the excluded specialists aside and back. */
async function concurrentBuild() {
  console.log("\nprofile generator during an eve build (8):");
  const dir = mkdtempSync(join(tmpdir(), "ui-vocab-race-"));
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
    rmSync(dir, { recursive: true, force: true });
  }
}

if (STAMPED) {
  await relabelled();
} else {
  await defaults();
  // RELABELLED: a copy stamped with the fixture, this file re-run inside it.
  const dir = mkdtempSync(join(tmpdir(), "ui-vocab-stamped-"));
  try {
    for (const e of ["agent", "lib", "data", "scripts", "profiles", "package.json", "dm.md", "docs"]) if (existsSync(join(ROOT, e))) cpSync(join(ROOT, e), join(dir, e), { recursive: true, filter: (s) => !s.includes("__pycache__") });
    mkdirSync(join(dir, "app/_components"), { recursive: true });
    cpSync(FIXTURE, join(dir, "profiles/50-relabelled.json"));
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    for (const s of ["scripts/gen-subagent-meta.mjs", "scripts/gen-deployment-profile.mjs"]) {
      const r = spawnSync(process.execPath, [s], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${s}: ${r.stderr}`);
    }
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/test-ui-vocabulary.mjs", "--stamped"], { cwd: dir, encoding: "utf8", stdio: "inherit" });
    if (r.status !== 0) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await concurrentBuild();
}
if (!STAMPED) console.log(process.exitCode ? "\nui vocabulary: SOME CHECKS FAILED" : "\nui vocabulary: every check passed");
