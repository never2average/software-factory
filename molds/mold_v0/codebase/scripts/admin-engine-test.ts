// The admin pages of an engine the build does not have (mold_v0-169), offline: an embedded database, the server's own
// modules called as the admin routes call them.
//   npm run test:admin-engine
//
// A build without the session engine (zero packs, or declarative packs; src/host-tables.ts):
//   1. Agent configuration (GET /compute, the admin MCP's list_settings) lists only the settings the build reads: no
//      orchestrator model, sessions per run or capacity; the Vertex AI region only once the vault holds a Vertex key; the
//      Cloudflare model under what it does there (the docs answers). Every setting may still be set (update_setting).
//   2. Key vault (GET /compute/keys, key_vault_status) lists only the providers the build reads: the shell's (email, the
//      docs answers' models); a gateway provider a pack's job kind names; the packs' operator credentials and OAuth clients
//      only when a pack declares them; boat only with APP_RUN_SANDBOX=boat; any provider that holds a key.
//   3. Compute (GET /compute/summary) has no orchestrator knob, says the autoscaler's kill switch in runs, never asks for
//      a boat key it does not use, and reports the packs' run sandboxes.
//   4. Data repositories: a repository's label is its pack's, else its id in words.
// A build with the session engine (a host pack owns its tables: run this test in that build, an app lane copy with it):
//   5. every setting and provider as before, and the Compute summary without any of the new fields.
// Every build: the console's Compute tabs follow the engine (its source, read).
import "./lib/test-world.js";
import "../src/hosts.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENGINE_KEYS = ["ORCHESTRATOR_MODEL", "MAX_SESSIONS_PER_RUN", "MAX_ORCHESTRATORS", "MAX_JOB_ORCHESTRATORS", "JOB_POD_CAPACITY", "BOAT_SANDBOX_SIZE"];
const ENGINE_PROVIDERS = ["amp", "boat", "cursor", "dashscope", "exa", "factory", "github_copilot", "google", "libraries_io"];
const SHELL_PROVIDERS = ["anthropic", "cloudflare", "openai", "resend", "vertex"];

try {
  const { getDb } = await import("../src/db.js");
  await getDb();
  const { sessionEngine } = await import("../src/host-tables.js");
  const settings = await import("../src/settings.js");
  const { modelKeys } = await import("../src/platform-keys.js");
  const kv = await import("../src/keyvault.js");
  const { computeSummary, computeVerdict, computeKnobs } = await import("../src/compute.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack, RepositorySchema } = await import("../src/pack-api.js");
  const { repositoryLabel } = await import("../src/data-repositories.js");
  const { persistedKey } = await import("../src/env-names.js");
  const keys = async () => (await settings.listSettings()).map((s) => s.key);
  const slugs = async () => (await modelKeys()).providers.map((p) => p.slug).sort();
  const engineKeys = ENGINE_KEYS.map((k) => (k === "ORCHESTRATOR_MODEL" || k === "BOAT_SANDBOX_SIZE" ? k : persistedKey(k)));

  if (!sessionEngine()) {
    // ---------- 1. Agent configuration ----------
    {
      const listed = await keys();
      for (const k of [...engineKeys, "VERTEX_REGION"]) assert.ok(!listed.includes(k), `no ${k} without the session engine (or a Vertex key)`);
      for (const k of ["CLOUDFLARE_AI_MODEL", "DOCS_ANSWERS_DAILY_MAX", "EMAILS_ENABLED", "EMAIL_FROM"]) assert.ok(listed.includes(k), `${k} is the shell's own`);
      const cf = (await settings.listSettings()).find((s) => s.key === "CLOUDFLARE_AI_MODEL")!;
      assert.equal(cf.label, "Quick answers model", "the Cloudflare model under what it does without the engine");
      assert.match(cf.help, /Ask AI/);
      assert.ok(!("readBy" in cf), "the API's rows carry no readBy");
      assert.deepEqual((await settings.listSettings({ all: true })).map((s) => s.key).filter((k) => engineKeys.includes(k)).sort(), [...engineKeys].sort(), "all: every setting");
      await settings.setSettings("test", { ORCHESTRATOR_MODEL: "claude-test-1" });
      assert.equal(settings.settingText("ORCHESTRATOR_MODEL"), "claude-test-1", "a setting the build does not list may still be set");
      await settings.setSettings("test", { ORCHESTRATOR_MODEL: null });
      const sa = JSON.stringify({ type: "service_account", project_id: "proj-test-1", client_email: "x@proj-test-1.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" });
      const saved = await kv.setCredential("vertex", sa);
      assert.ok((await keys()).includes("VERTEX_REGION"), "with a Vertex key: the Vertex AI region");
      await kv.deleteCredential(saved.id);
      assert.ok(!(await keys()).includes("VERTEX_REGION"), "and without it again: not listed");
      console.log("✓ no engine: Agent configuration lists the shell's and the packs' settings only (Vertex region with a Vertex key)");
    }

    // ---------- 2. Key vault ----------
    {
      setPacksForTest([]);
      assert.deepEqual(await slugs(), [...SHELL_PROVIDERS, "github_app"].sort(), "zero packs: the shell's providers only (github_app has its own section)");
      const fixture = definePack({
        id: "fixture_vault",
        jobKinds: [{ name: "scan", label: "Scan", runner: "workspace-harness", entry: "noop.mjs", lease_seconds: 15, providers: ["google"],
          operator_credentials: ["catalogue_login"] }],
        operatorCredentials: [{ name: "catalogue_login", label: "Catalogue login", deliver_as: { env: "FIXTURE_CAT_LOGIN" } }],
        credentials: [{ name: "gh", label: "GitHub", bound_to: "workspace", oauth: "gh", deliver_as: { env: "FIXTURE_GH" } }],
        oauthProviders: [{ name: "gh", label: "GitHub", authorize_url: "https://github.com/login/oauth/authorize", token_url: "https://github.com/login/oauth/access_token",
          client_id: { vault: "fixture_vault.gh_id" }, client_secret: { vault: "fixture_vault.gh_secret" } }],
      });
      setPacksForTest([{ manifest: { id: "fixture_vault", name: "Fixture vault", version: "1", entry: "index.ts", migrations: null, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture } as never]);
      assert.deepEqual(await slugs(), [...SHELL_PROVIDERS, "github_app", "google", "oauth_clients", "pack_credentials"].sort(),
        "a pack's kind's gateway provider, its operator credentials and its OAuth clients");
      setPacksForTest([]);
      const held = await kv.setCredential("google", "gemini-test-key-0123456789", { label: "held" });
      assert.ok((await slugs()).includes("google"), "a provider holding a key is always listed");
      await kv.deleteCredential(held.id);
      const was = process.env.APP_RUN_SANDBOX;
      process.env.APP_RUN_SANDBOX = "boat";
      assert.ok((await slugs()).includes("boat"), "APP_RUN_SANDBOX=boat: the packs' runs use boat");
      if (was === undefined) delete process.env.APP_RUN_SANDBOX; else process.env.APP_RUN_SANDBOX = was;
      for (const p of ENGINE_PROVIDERS) assert.ok(!(await slugs()).includes(p), `no ${p}`);
      console.log("✓ no engine: Key vault lists the shell's providers, what the packs declare and any provider holding a key");
    }

    // ---------- 3. Compute ----------
    {
      const s = await computeSummary({ fresh: true }) as Record<string, any>;
      assert.equal(s.engine, false);
      assert.equal(s.uses_boat, false, "no boat key, APP_RUN_SANDBOX auto: boat is not used");
      assert.deepEqual(Object.keys(s.runs).sort(), ["launches_per_tick", "live", "max", "mode", "queued"]);
      assert.equal(s.runs.max, 10);
      assert.ok(!s.verdict.some((v: { code: string }) => v.code === "no_boat_key"), "never asks for a boat key it does not use");
      assert.equal(s.verdict.find((v: { code: string }) => v.code === "autoscale_off")?.text, "The autoscaler is off. Queued runs will not get a sandbox.");
      const knobs = computeKnobs("vm").map((k) => k.name);
      assert.ok(knobs.includes("APP_RUN_SANDBOX") && knobs.includes("APP_MAX_RUN_SANDBOXES"), "the run sandboxes' knobs");
      assert.ok(!knobs.some((k) => /ORCH|POD|SESSION|BOAT_NAMESPACE|RESEARCH/.test(k)), `no orchestrator knob: ${knobs}`);
      assert.ok(!s.settings.some((x: { key: string }) => engineKeys.includes(x.key)), "no capacity setting");
      console.log("✓ no engine: Compute's summary says runs, not orchestrators, and asks for no boat key");
    }

    // ---------- 4. Data repositories ----------
    {
      assert.equal(repositoryLabel("company_ledger"), "Company ledger");
      assert.equal(repositoryLabel("company_ledger", "Control ledger"), "Control ledger");
      assert.equal(RepositorySchema.safeParse({ kind: "shell_tables", label: "Shared tables" }).success, true, "a repository may name its label");
      assert.equal(RepositorySchema.safeParse({ kind: "shell_tables", label: "two\nlines" }).success, false, "on one line");
      console.log("✓ repositories: the pack's label, else the id in words");
    }
  } else {
    // ---------- 5. a build with the session engine: as before ----------
    const listed = await keys();
    for (const k of [...engineKeys, "VERTEX_REGION", "CLOUDFLARE_AI_MODEL"]) assert.ok(listed.includes(k), `${k} with the engine`);
    assert.equal((await settings.listSettings()).find((s) => s.key === "CLOUDFLARE_AI_MODEL")!.label, "Research quick-pass model");
    const have = await slugs();
    for (const p of [...ENGINE_PROVIDERS, ...SHELL_PROVIDERS]) assert.ok(have.includes(p), `${p} with the engine`);
    for (const p of ["pack_credentials", "oauth_clients"]) assert.equal(have.includes(p), false, `${p}: no pack of this build declares any`);
    const s = await computeSummary({ fresh: true }) as Record<string, any>;
    for (const k of ["engine", "uses_boat", "runs"]) assert.ok(!(k in s), `the summary has no ${k} with the engine`);
    assert.ok(s.knobs.some((k: { name: string }) => /ORCH_PER_JOB/.test(k.name)), "the engine's knobs");
    assert.ok(s.verdict.some((v: { code: string }) => v.code === "no_boat_key"), "the engine needs a boat key");
    console.log("✓ the session engine: every setting, provider and Compute figure as before");
  }

  // ---------- the verdict, pure: the engine's rules when a caller says nothing ----------
  {
    const facts = {
      enabled: false, runtime: "vm" as const, kick_configured: true, has_boat_key: false, boat_error: null,
      tick: { age_s: 5, error: null, note: null }, queue: { sessions: 0, research: 0, oldest_session_age_s: null, oldest_research_age_s: null, unclaimable: 0 },
      running: { sessions: 0, orchestrators: 0 }, others: 0, free: 3, per_job: true, job_orch_live: 0, job_orch_cap: 4, not_checking_in: 0,
      launch_failures_1h: { count: 0, step: null, message: null }, missing_keys: [], leaked_workers: 0, orphan_deletes_24h: 0, namespace: "app", idle_orchestrators: 0,
    };
    assert.deepEqual(computeVerdict(facts).map((v) => v.code), ["autoscale_off", "no_boat_key"]);
    assert.match(computeVerdict(facts)[0]!.text, /orchestrators/);
    assert.deepEqual(computeVerdict({ ...facts, engine: false, uses_boat: false }).map((v) => v.code), ["autoscale_off"]);
    assert.deepEqual(computeVerdict({ ...facts, enabled: true, engine: false, uses_boat: false }).map((v) => v.text), ["Compute is healthy."]);
    assert.deepEqual(computeVerdict({ ...facts, enabled: true, engine: false, uses_boat: true }).map((v) => v.code), ["no_boat_key"], "runs on boat need its key");
    console.log("✓ the verdict: the engine's rules by default; runs' words and no boat rule without it");
  }

  // ---------- the console ----------
  {
    const compute = readFileSync(path.join(ROOT, "web/src/features/admin/compute.tsx"), "utf8");
    assert.match(compute, /\.\.\.\(ENGINE \? \[\['orchestrators', 'Orchestrators'\], \['failures', 'Failures'\], \['decisions', 'Autoscaler decisions'\], \['limits', 'Limits'\]\]/,
      "Compute: orchestrators, failures and decisions only with the engine");
    assert.match(compute, /\.\.\.\(boat \? boatRows : \[\]\)/, "boat's rows only when the build uses it");
    const conf = readFileSync(path.join(ROOT, "web/src/features/admin/configuration.tsx"), "utf8");
    assert.doesNotMatch(conf, /truncate text-xs' title=\{x\.help\}/, "Agent configuration's help wraps (the value column stays on the page)");
    const repos = readFileSync(path.join(ROOT, "web/src/features/admin/repositories.tsx"), "utf8");
    assert.doesNotMatch(repos, /APP_CATALOG_AUTOINDEX/, "no environment name on the Data repositories page");
    console.log("✓ console: Compute's tabs and rows follow the engine; configuration wraps; repositories in words");
  }
  console.log("admin-engine: ok");
} finally {
  cleanup();
}
process.exit(0);
