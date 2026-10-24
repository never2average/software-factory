// The admin console's account funnel, needs-attention and run sections per build (mold_v0-103, mold_v0-104, mold_v0-126), offline:
// an embedded database, the admin module called as its routes call it.
//   npm run test:admin-sections
//
// A build without the session engine (zero packs, or declarative packs):
//   1. zero packs: the shell's five stages only (account created to first tool call); an account that has used tools
//      for days is not told to onboard a product; no products, research, simulations or pack runs on its page; the
//      Analytics funnel stops at the first tool call and has no weekly-runs chart; FinOps' runs list is empty and,
//      with no pricing experiment, its Experiments tab is not listed
//   2. a declarative pack (fixture, its word for a run "check"): the shell's stages, then one per onboarding step that is
//      not the shell's own (record:, credential:, run:, tool:), reached from what each account really did; an account
//      stuck at a step is named with the pack's next step; its page lists its runs per job kind by the kind's label, in
//      the pack's word; the month's spend is its runs'; Analytics' funnel and weekly chart and FinOps' runs per kind
//      (with their cost, over its period) read the same runs; an account shown a plan variant brings Experiments back
// A build with the session engine (a host pack owns its tables: run this test in that build):
//   3. the stages, their next steps, the attention messages, the funnel and the account page are exactly the engine's,
//      as they were before mold_v0-103: no pack stage, no pack runs, no new field on its rows
// Every build: the console lists FinOps' runs tab in the Experiments slot, and Health no longer lists one (its old link
// redirects to FinOps).
import "./lib/test-world.js";
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, STAMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * DAY - hours * 3_600_000).toISOString();

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const { sessionEngine } = await import("../src/host-tables.js");
  const admin = await import("../src/admin.js");
  const insights = await import("../src/insights.js");
  const jobs = await import("../src/compute-jobs.js");
  const { createOrg } = await import("../src/auth.js");

  /** An account created `days` ago, with its first successful tool call `callDays` ago (none when null). */
  const account = async (name: string, days: number, callDays: number | null) => {
    const { org } = await createOrg(`${name} ${STAMP}`);
    await db.query("UPDATE organizations SET created_at = $2 WHERE id = $1", [org.orgId, ago(days)]);
    if (callDays != null) {
      await db.query("INSERT INTO mcp_events (org_id, method, name, ok, ms, at) VALUES ($1, 'initialize', NULL, true, 5, $2)", [org.orgId, ago(callDays, 1)]);
      await db.query("INSERT INTO mcp_events (org_id, method, name, ok, ms, at) VALUES ($1, 'tools/call', 'list_records', true, 5, $2)", [org.orgId, ago(callDays)]);
    }
    return org;
  };
  const rowOf = async (slug: string) => (await admin.listOrgs(false)).orgs.find((o) => o.slug === slug)!;
  const growth = async () => (await insights.platformAnalytics({ days: "30" }) as unknown as { growth: { funnel: { id: string; label: string; reached: number }[] | null; sims_weekly: unknown } }).growth;

  if (!sessionEngine()) {
    const { setPacksForTest } = await import("../src/packs.js");
    const { definePack } = await import("../src/pack-api.js");
    const SHELL = ["created", "invited", "joined", "connected", "first_call"];

    // ---------- 1. zero packs ----------
    {
      setPacksForTest([]);
      assert.deepEqual(admin.accountStages().map((s) => s.id), SHELL, "zero packs: the shell's stages only");
      assert.equal(admin.accountStages().at(-1)!.next.includes("product"), false, "no 'onboard a product' after the first call");
      const z = await account("Zero", 5, 4);
      const row = await rowOf(z.slug);
      assert.equal(row.stage, "first_call");
      assert.deepEqual(row.attention, [], "days after the first call, nothing to chase: no pack step is missing");
      assert.equal(row.attention.some((a) => /onboarded a product/.test(a)), false);
      assert.deepEqual(Object.keys(row.reached), SHELL);
      assert.equal(row.runs_running, 0);
      const d = await admin.orgDetail(z.slug) as Record<string, any>;
      assert.equal(d.engine, false, "the account page says the session engine is not there");
      assert.equal(d.runs, null, "no job kind: no runs section");
      assert.deepEqual([d.products, d.research, d.simulations], [[], [], []]);
      const g = await growth();
      assert.deepEqual(g.funnel!.map((f) => f.id), ["requests", "created", "first_call"], "the Analytics funnel stops at the first tool call");
      assert.equal(g.sims_weekly, null, "no weekly-runs chart without runs");
      assert.deepEqual((await jobs.runKinds({})).kinds, [], "FinOps: no job kind, no runs list");
      const exps = await import("../src/experiments.js");
      assert.equal(await exps.anyPricingExperiment(), false, "no plan in an experiment (Stripe off) and no exposure: FinOps hides Experiments");
      console.log("✓ zero packs: the shell's five stages, no false 'not onboarded a product', no product or pack-run sections");
    }

    // ---------- 2. a declarative pack ----------
    {
      const fixture = definePack({
        id: "fixture_admin",
        recordAreas: [{ name: "adm_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] }],
        credentials: [{ name: "repo_token", label: "Repository token", bound_to: "workspace", deliver_as: { env: "FIXTURE_ADM_TOKEN" } }],
        jobKinds: [
          { name: "first_check", label: "Check the application", runner: "workspace-harness", entry: "noop.mjs", lease_seconds: 15 },
          { name: "deep_check", label: "Check it in depth", runner: "workspace-harness", entry: "noop.mjs", lease_seconds: 15 },
        ],
        onboarding: [
          { id: "made", label: "Workspace made", done_when: "workspace" },
          { id: "first", label: "Make a first call", done_when: "first_call" },
          { id: "app", label: "Add your first application", done_when: "record:adm_apps" },
          { id: "token", label: "Give a repository token", done_when: "credential:repo_token" },
          { id: "checked", label: "Run your first check", done_when: "run:first_check" },
        ],
      });
      setPacksForTest([{ manifest: { id: "fixture_admin", name: "Fixture admin", version: "1", entry: "index.ts", migrations: null, words: { run: "check" }, dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture }]);
      const stages = admin.accountStages();
      assert.deepEqual(stages.map((s) => s.id), [...SHELL, "fixture_admin:app", "fixture_admin:token", "fixture_admin:checked"],
        "the shell's stages, then the pack's steps that are not the shell's own");
      assert.equal(stages[4]!.next, "Add your first application", "after the first call: the pack's first step");
      assert.equal(stages[5]!.next, "Give a repository token");
      assert.equal(stages[7]!.label, "Run your first check");

      // P: stuck after the first call (3 days); Q: added an application 3 days ago, nothing since; R: all steps done.
      const P = await account("Pstuck", 6, 3), Q = await account("Qapp", 6, 5), R = await account("Rdone", 9, 8);
      const rec = (org: { orgId: number }, key: string, days: number) => db.query(
        "INSERT INTO workspace_records (org_id, pack, area, key, title, created_at) VALUES ($1, 'fixture_admin', 'adm_apps', $2, $2, $3)", [org.orgId, key, ago(days)]);
      await rec(Q, "web", 3); await rec(R, "web", 7);
      const creds = await import("../src/credentials.js");
      await creds.setCredential(R.orgId, "test", { pack: "fixture_admin", name: "repo_token", value: "r-token-value-123" });
      const run = (org: { orgId: number }, id: string, kind: string, status: string, days: number, cost: number, error: string | null = null) => db.query(
        `INSERT INTO runs (id, org_id, pack, kind, status, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, cost_usd, created_at, started_at, ended_at, error)
         VALUES ($1, $2, 'fixture_admin', $3, $4, '{}'::jsonb, 1, 3600, 120, 5, $5, $6, $6, CASE WHEN $4 IN ('succeeded', 'failed') THEN $6::timestamptz + interval '10 minutes' END, $7)`,
        [id, org.orgId, kind, status, cost, ago(days), error]);
      await run(R, `run_r1_${STAMP}`, "first_check", "succeeded", 0, 1.25);
      await run(R, `run_r2_${STAMP}`, "deep_check", "failed", 0, 0.5, "the repository could not be read");
      await run(R, `run_r3_${STAMP}`, "first_check", "running", 0, 0);

      const p = await rowOf(P.slug), q = await rowOf(Q.slug), r = await rowOf(R.slug);
      assert.equal(p.stage, "first_call");
      assert.equal(p.next_step, "Add your first application");
      assert.deepEqual(p.attention, ['3d at "First tool call", next step not done: Add your first application'], "stuck after the first call: the pack's next step");
      assert.equal(q.stage, "fixture_admin:app");
      assert.deepEqual(q.attention, ['3d at "Add your first application", next step not done: Give a repository token']);
      assert.equal(r.stage, "fixture_admin:checked", "every step done: the last stage");
      assert.deepEqual(r.attention, [], "the last stage: nothing to chase");
      assert.equal(r.runs_running, 1, "its running check counts as running");
      assert.equal(Number(r.month_spend_usd), 1.75, "the month's spend is its runs'");
      for (const o of [p, q, r]) assert.equal(o.attention.some((a) => /product|simulation/i.test(a)), false, "no session-engine wording");
      assert.ok(r.reached["fixture_admin:token"] && r.reached["fixture_admin:checked"], "each step's time is there");

      const d = await admin.orgDetail(R.slug) as Record<string, any>;
      assert.equal(d.engine, false);
      assert.deepEqual(d.runs.word, { one: "Check", many: "Checks" }, "the pack's word for a run");
      const byKind = Object.fromEntries(d.runs.by_kind.map((k: any) => [k.kind, k]));
      assert.equal(byKind.first_check.label, "Check the application", "each kind by its label");
      assert.deepEqual([byKind.first_check.total, byKind.first_check.succeeded, byKind.first_check.running], [2, 1, 1]);
      assert.deepEqual([byKind.deep_check.label, byKind.deep_check.failed], ["Check it in depth", 1]);
      assert.equal(d.runs.recent.length, 3);
      assert.equal(d.runs.recent.find((x: any) => x.status === "failed").error, "the repository could not be read");
      assert.equal(d.daily.runs.reduce((a: number, b: number) => a + b, 0), 3, "the runs per day");

      const g = await growth();
      const f = Object.fromEntries(g.funnel!.map((x) => [x.id, x.reached]));
      assert.deepEqual(g.funnel!.map((x) => x.id), ["requests", "created", "first_call", "fixture_admin:app", "fixture_admin:token", "fixture_admin:checked"]);
      assert.ok(f["fixture_admin:app"]! >= 2 && f["fixture_admin:checked"]! >= 1, "the funnel counts the pack's steps");
      const weeks = g.sims_weekly as { completed: number; other: number }[];
      assert.ok(Array.isArray(weeks) && weeks.reduce((a, w) => a + w.completed + w.other, 0) === 3, "the weekly chart counts the pack's runs");
      const kinds = await jobs.runKinds({ since: "24h" });
      assert.deepEqual(kinds.words, { one: "Check", many: "Checks" });
      const k1 = kinds.kinds.find((k) => k.kind === "first_check")!, k2 = kinds.kinds.find((k) => k.kind === "deep_check")!;
      assert.deepEqual([k1.label, k1.total, k1.succeeded, k1.running, k1.accounts, k1.usd], ["Check the application", 2, 1, 1, 1, 1.25]);
      assert.deepEqual([k2.failed, k2.last_error], [1, "the repository could not be read"]);
      // FinOps' runs tab (mold_v0-126): the same runs over FinOps' period (from, to), with their cost.
      const today = new Date().toISOString().slice(0, 10), weekAgo = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
      const fin = await jobs.runKinds({ from: weekAgo, to: today });
      assert.deepEqual(fin.range, { from: weekAgo, to: today });
      const f1 = fin.kinds.find((k) => k.kind === "first_check")!;
      assert.deepEqual([f1.label, f1.total, f1.usd], ["Check the application", 2, 1.25], "the period's runs per kind and their cost");
      const old = await jobs.runKinds({ from: "2020-01-01", to: "2020-01-31" });
      assert.equal(old.kinds.reduce((a, k) => a + k.total, 0), 0, "a period with none: every kind at zero");
      setPacksForTest(null);
      console.log("✓ a declarative pack: its onboarding steps are the stages after the first call, stuck accounts get its next step, runs per kind in its words");

      // ---------- FinOps' Experiments tab: only with a pricing experiment ----------
      const exps = await import("../src/experiments.js");
      await db.query("INSERT INTO plan_exposures (org_id, experiment, price_id, plan_name) VALUES ($1, 'team-price', 'price_x', 'Team')", [R.orgId]);
      assert.equal(await exps.anyPricingExperiment(), true, "an account was shown a variant: the Experiments tab stays reachable");
      await db.query("DELETE FROM plan_exposures WHERE org_id = $1", [R.orgId]);
      console.log("✓ FinOps: runs per kind with their cost over its period; Experiments only when a pricing experiment exists");
    }
  } else {
    // ---------- 3. a host pack with the session engine ----------
    const golden = [
      { id: "created", label: "Account created", next: "Invite the first person" },
      { id: "invited", label: "Invited", next: "Accept the invitation email" },
      { id: "joined", label: "Joined", next: "Add the connector in Claude, ChatGPT or an IDE and sign in" },
      { id: "connected", label: "Connected", next: `Ask: "Get me started with ${(await import("../src/profile.js")).PROFILE.name}"` },
      { id: "first_call", label: "First tool call", next: "Onboard a product (name, website, docs)" },
      { id: "onboarded", label: "Product onboarded", next: "Run a simulation" },
      { id: "simulated", label: "Simulation run", next: "Open the visibility report" },
      { id: "reported", label: "Report read", next: "Act on the report and re-run" },
    ];
    assert.deepEqual(admin.accountStages(), golden, "the session engine's stages, word for word");
    const H = await account("Host", 6, 3);
    const row = await rowOf(H.slug) as Record<string, any>;
    assert.equal(row.stage, "first_call");
    assert.deepEqual(row.attention, ["Using tools but has not onboarded a product"], "the engine's own message");
    assert.equal("runs_running" in row, false, "no new field on its rows");
    assert.deepEqual(Object.keys(row.reached), golden.map((s) => s.id));
    const [p] = await db.query<{ id: number }>("INSERT INTO products (org_id, slug, name) VALUES ($1, 'p', 'P') RETURNING id", [H.orgId]);
    await db.query("UPDATE products SET created_at = $2 WHERE id = $1", [p!.id, ago(3)]);
    assert.deepEqual((await rowOf(H.slug)).attention, ["Product onboarded, no simulation yet"]);
    const d = await admin.orgDetail(H.slug) as Record<string, any>;
    assert.equal("engine" in d || "runs" in d || "runs" in d.daily, false, "the account page is the engine's, unchanged");
    const g = await growth();
    assert.deepEqual(g.funnel!.map((x) => [x.id, x.label]), [["requests", "Access requests"], ["created", "Accounts"], ["onboarded", "Onboarded"], ["simulated", "First simulation"], ["reported", "First report"]]);
    assert.ok(Array.isArray(g.sims_weekly), "the engine's weekly chart");
    console.log("✓ a host pack with the session engine: stages, attention, account page and funnel exactly the engine's");
  }
  // ---------- the console: FinOps' runs tab in Experiments' place, Health without it (mold_v0-126) ----------
  {
    const { readFileSync } = await import("node:fs");
    const spend = readFileSync(path.join(ROOT, "web/src/features/admin/spend.tsx"), "utf8");
    const health = readFileSync(path.join(ROOT, "web/src/features/admin/analytics.tsx"), "utf8");
    assert.match(spend, /\['plans', 'Plans'\], \['runs', W\.Runs\], \['experiments', 'Experiments'\]/, "FinOps: the runs tab, in the build's word, where Experiments was, Experiments after it");
    assert.match(spend, /id !== 'runs' \|\| packRuns\(\)/, "the runs tab only with the packs' runs");
    assert.match(spend, /id !== 'experiments' \|\| tab === 'experiments' \|\| anyExperiment/, "Experiments only with a pricing experiment, or when a link opens it");
    assert.doesNotMatch(health, /\['runs', /, "Health lists no runs tab");
    assert.match(health, /runs: '\/admin\/finops\?section=runs'/, "Health's old runs link goes to FinOps");
    console.log("✓ console: FinOps' runs tab in the Experiments slot (Experiments only with an experiment); Health's old runs link redirects");
  }
  console.log("admin-sections: ok");
} finally {
  cleanup();
}
process.exit(0);
