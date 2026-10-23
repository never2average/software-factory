// Plan entitlements (mold_v0-083; src/entitlements.ts), offline: an embedded database, the run world of
// scripts/lib/spend-world.ts (a fixture pack with priced job kinds), and gen-packs on a throwaway profile.
//   npm run test:entitlements
//
// 1. Nothing declared: every workspace has every feature and runs are priced as billing says (as before).
// 2. A workspace's plan: its live subscription's when declared, else without_plan; never a name a request or a pack
//    sends, never an inherited property ("constructor", "__proto__"); an undeclared plan unlocks nothing.
// 3. Features where 018's limits are read: a run starts only on a plan that includes runs (403 otherwise, before any
//    run is written); the refusal names the plan.
// 4. Run charges where 019's billing reads them: on a plan whose runs are included, a priced kind's run is frozen with
//    no price and is never charged; on a charged plan it is priced as billing says.
// 5. The profile: gen-packs takes `entitlements` and `email` from profile.json, refuses typos, unknown features and
//    groups, a without_plan that is not a plan, limits for a plan entitlements does not declare, and entitlements from
//    a host pack's profile; neither reaches the console's copy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, STAMP } from "./lib/test-world.js";
import { spendWorld } from "./lib/spend-world.js";

let n = 0;
const ok = (what: string) => { n++; console.log(`✓ ${what}`); };

try {
  const w = await spendWorld([
    { name: "flat", budget_usd: 5, price: { currency: "usd", fixed: 2.5 } },
  ], { tools: false });
  const { createOrg } = await import("../src/auth.js");
  const ent = await import("../src/entitlements.js");
  const rc = await import("../src/run-charges.js");
  const { planOf } = await import("../src/rate-limits.js");
  const A = (await createOrg(`Plans A ${STAMP}`)).org;
  const runsOf = async () => (await w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM runs WHERE org_id = $1", [A.orgId]))[0]!.n;
  const priceOf = async (id: string) => (await w.db.query<{ price: unknown }>("SELECT price FROM runs WHERE id = $1", [id]))[0]!.price;
  const PLANS = {
    plans: {
      basic: { features: [] as string[] },
      team: { features: ["runs"], run_charges: "included" as const },
      pro: { features: ["runs", "schedules"] },
    },
    without_plan: "basic",
  };
  try {
    // ---------- 1. nothing declared ----------
    await ent.setEntitlementsForTest(undefined);
    assert.equal(ent.entitlementsProfile(), null, "the shell's profile declares no entitlements");
    const all = await ent.workspaceEntitlements(A.orgId);
    assert.deepEqual([all.gated, [...all.features].sort(), all.run_charges], [false, ["runs", "schedules"], "charged"]);
    rc.setBillingForTest({ enabled: true, currency: "usd" });
    const r0 = await w.start(A.orgId, "flat");
    assert.ok(await priceOf(r0.id), "billing on and nothing declared: the run is priced");
    ok("nothing declared: every feature, runs priced as billing says");

    // ---------- 2. the plan ----------
    const e = PLANS as Parameters<typeof ent.resolvePlan>[1];
    assert.equal(ent.resolvePlan("pro", e), "pro", "a live subscription's declared plan");
    assert.equal(ent.resolvePlan("enterprise", e), "basic", "a plan not declared here: without_plan");
    assert.equal(ent.resolvePlan(null, e), "basic", "no subscription: without_plan");
    for (const sneaky of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.equal(ent.resolvePlan(sneaky, e), "basic", `${sneaky}: not a plan`);
      assert.deepEqual([...ent.entitlementsFor(sneaky, e).features], [], `${sneaky} unlocks nothing`);
    }
    assert.deepEqual([...ent.entitlementsFor("nope", e).features], [], "an undeclared plan unlocks nothing");
    assert.deepEqual([...ent.entitlementsFor("pro", { plans: { pro: { features: ["runs", "teleport"] } }, without_plan: "pro" }).features], ["runs"], "an unknown feature unlocks nothing");
    await ent.setEntitlementsForTest(PLANS);
    assert.equal(await planOf(A.orgId), "basic", "a workspace with no subscription is on without_plan");
    ok("the plan: the live subscription's when declared, else without_plan; inherited names and undeclared plans unlock nothing");

    // ---------- 3. features: runs ----------
    const before = await runsOf();
    await assert.rejects(w.start(A.orgId, "flat"), (err: Error & { status?: number }) =>
      err.status === 403 && /plan \(basic\) does not include start runs/.test(err.message));
    assert.equal(await runsOf(), before, "refused before any run is written");
    ok("features: a plan without runs starts none (403, naming the plan), and writes nothing");

    // ---------- 4. run charges ----------
    await ent.setEntitlementsForTest({ ...PLANS, without_plan: "team" });
    const r1 = await w.start(A.orgId, "flat");
    assert.equal(await priceOf(r1.id), null, "an included plan's run carries no price");
    await ent.setEntitlementsForTest({ ...PLANS, without_plan: "pro" });
    const r2 = await w.start(A.orgId, "flat");
    assert.equal((await priceOf(r2.id) as { fixed_minor: number }).fixed_minor, 250, "a charged plan's run is priced as billing says");
    // The runs end: the included one writes no charge, the charged one exactly one.
    for (let c = await w.claim(["flat"]); c; c = await w.claim(["flat"])) await w.complete(c);
    const charges = async (id: string) => (await w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_charges WHERE run_id = $1 AND kind = 'charge'", [id]))[0]!.n;
    assert.equal(await charges(r1.id), 0, "an included run is never charged");
    assert.equal(await charges(r2.id), 1, "a charged run is charged once");
    ok("run charges: an included plan's runs are never priced or charged; a charged plan's are, as billing says");
  } finally {
    rc.setBillingForTest(undefined);
    await ent.setEntitlementsForTest(undefined);
    await w.close();
  }

  // ---------- 5. the profile ----------
  const dir = mkdtempSync(path.join(tmpdir(), "entitlements-gen-"));
  try {
    mkdirSync(path.join(dir, "packs")); mkdirSync(path.join(dir, "out"));
    const gen = (profile: unknown) => {
      writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile));
      return spawnSync(process.execPath, ["scripts/gen-packs.mjs", "--packs", path.join(dir, "packs"), "--out", path.join(dir, "out"), "--profile", path.join(dir, "profile.json")],
        { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
    };
    const good = gen({ name: "Shell", entitlements: { plans: { free: { features: ["runs"] }, team: { features: ["runs", "schedules"], run_charges: "included" } }, without_plan: "free" },
      limits: { plans: { team: { runs: { live_per_workspace: 50 } } } }, email: { provider: "resend", notifications: ["due_dates", "usage"] } });
    assert.equal(good.status, 0, good.stderr);
    const server = readFileSync(path.join(dir, "out", "src", "profile.generated.ts"), "utf8");
    assert.ok(server.includes('"without_plan": "free"') && server.includes('"due_dates"'), "entitlements and email reach the server's generated profile");
    const web = readFileSync(path.join(dir, "out", "web", "src", "config", "profile.generated.ts"), "utf8");
    assert.ok(!web.includes("entitlements") && !web.includes("notifications"), "and never the console's");
    const refused: [unknown, RegExp][] = [
      [{ entitlements: { plans: { free: { features: ["runs"] } } } }, /without_plan must name one of the plans/],
      [{ entitlements: { plans: { free: { features: ["runs"] } }, without_plan: "gold" } }, /without_plan must name one of the plans/],
      [{ entitlements: { plans: { free: { features: ["teleport"] } }, without_plan: "free" } }, /teleport/],
      [{ entitlements: { plans: { free: { features: ["runs", "runs"] } }, without_plan: "free" } }, /each once/],
      [{ entitlements: { plans: { free: { features: [], run_charges: "free" } }, without_plan: "free" } }, /run_charges must be charged or included/],
      [{ entitlements: { plans: { free: { features: [], price: 3 } }, without_plan: "free" } }, /not a plan setting/],
      [{ entitlements: { plans: {}, without_plan: "free" } }, /plans must be an object/],
      [{ entitlements: { plans: { "__proto__": { features: [] } }, without_plan: "__proto__" } }, /entitlements/],
      [{ entitlements: { plans: { free: { features: [] } }, without_plan: "free" }, limits: { plans: { gold: { runs: { live_per_workspace: 1 } } } } }, /limits\.plans names gold/],
      [{ email: { provider: "smtp" } }, /provider must be resend, test or none/],
      [{ email: { notifications: ["due_dates", "spam"] } }, /spam/],
      [{ email: { notify: [] } }, /not an email setting/],
    ];
    for (const [pf, why] of refused) {
      const r = gen({ name: "Shell", ...(pf as object) });
      assert.ok(r.status !== 0 && why.test(r.stderr), `gen-packs refuses ${JSON.stringify(pf)}: ${r.stderr.slice(0, 300)}`);
    }
    // A host pack's profile may bring the product's email notifications, never its entitlements.
    const pk = path.join(dir, "packs", "host_plans");
    mkdirSync(pk);
    writeFileSync(path.join(pk, "host.ts"), "export default {};\n");
    const hostWith = (profile: unknown) => writeFileSync(path.join(pk, "pack.json"), JSON.stringify({ id: "host_plans", name: "Host plans", version: "1", host: { entry: "host.ts", profile } }));
    hostWith({ entitlements: { plans: { free: { features: ["runs", "schedules"] } }, without_plan: "free" } });
    const host = gen({ name: "Shell", host_packs: ["host_plans"] });
    assert.ok(host.status !== 0 && /may not set entitlements/.test(host.stderr), `a host pack's profile may not set entitlements: ${host.stderr.slice(0, 300)}`);
    hostWith({ email: { notifications: ["access_requests"] } });
    const hostEmail = gen({ name: "Shell", host_packs: ["host_plans"] });
    assert.equal(hostEmail.status, 0, hostEmail.stderr);
    assert.ok(readFileSync(path.join(dir, "out", "src", "profile.generated.ts"), "utf8").includes('"access_requests"'), "a host pack's profile may turn the product's notifications on");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  ok("the profile: entitlements and email checked by gen-packs; entitlements only from the app's own profile.json; neither in the console's copy");
  console.log(`ENTITLEMENTS TEST PASS (${n} groups)`);
} finally {
  cleanup();
}
process.exit(0);
