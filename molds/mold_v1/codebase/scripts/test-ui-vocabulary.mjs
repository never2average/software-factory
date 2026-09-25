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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const STAMPED = process.argv.includes("--stamped");
const FIXTURE = join(new URL("..", import.meta.url).pathname, "scripts/fixtures/agent-vocabulary/50-relabelled.json");
const BASE = new Set(["customer", "customers", "deployment", "deployments", "implementation", "implementations", "rollout", "rollouts", "fde", "fdes"]);
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
}

async function defaults() {
  console.log("default profile (this checkout):");
  const keys = await imp("lib/ui-keys.ts");
  await check("D JSON a person reads is byte-identical to JSON.stringify", () => {
    assert.equal(keys.jsonForPeople({ record: RECORD }, 2), JSON.stringify({ record: RECORD }, null, 2));
    assert.equal(keys.jsonForPeople(RECORD), JSON.stringify(RECORD));
  });
  await check("D speakKey / humanizeKey are the identity", () => {
    for (const k of ["customer_id", "deployment_model", "deploymentId", "fdeOwner"]) assert.equal(keys.speakKey(k), k);
    assert.equal(keys.humanizeKey("fdeOwner"), "Fde Owner");
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
  await check("D every library row is available and returned as stored", () => {
    for (const w of lib) {
      const row = avail.workflowForList({ ...w });
      assert.equal(row.availability.available, true);
      assert.equal(row.description, w.description);
    }
  });

  const exp = await imp("lib/record-export.ts");
  const B = { type: "deployment", record: { containerType: "deployment", blockerOwner: "Customer", fdeOwner: "a@x", custom: { customer_tier: "gold" } }, resolved: { comments: [{ author: "a", body: "b" }] }, dataroom: { customerId: "acme", context: "ctx", files: { "s.json": { type: "deployment" } } } };
  await check("D Copy as JSON is byte-identical to the API's bundle; Markdown to the former rendering", () => {
    assert.equal(exp.exportJson(B), JSON.stringify(B, null, 2));
    const md = exp.bundleToMarkdown("T", B);
    assert.match(md, /- \*\*Container Type:\*\* deployment/);
    assert.match(md, /- \*\*Fde Owner:\*\* a@x/);
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
