// Run spend in the account's month figures and spend pages (mold_v0-053; src/run-spend.ts), offline: an embedded
// database, the real gateway in front of a fake model ($0.12 a request), two workspaces.
//   npm run test:run-spend
//
//  1. A running run's live gateway spend counts in its workspace's month figure (orgMonthSpendUsd), and still does once
//     it completed; the other workspace's figure is untouched.
//  2. Under row-level security a workspace reads its own run spend and never another's (asking for A's figure while
//     scoped to B gives 0), and B's tenant work sees none of A's run usage rows.
//  3. The admin Spend page (spendReport, accountSpend) and the month's pace (monthFigures) count runs.
//  4. The portal's Usage and Billing pages count A's runs; B's pages are as before (no runs section).
//  5. Budgets that read month spend include runs: with the allowance used up by runs, a new run is refused and a running
//     run's next gateway request is refused (429).
import assert from "node:assert/strict";
import { cleanup, STAMP } from "./lib/test-world.js";
import { PER_REQUEST_USD, spendWorld } from "./lib/spend-world.js";

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} (expected ${b})`);
try {
  const w = await spendWorld([{ name: "metered", providers: ["anthropic"], budget_usd: 5 }]);
  const { createOrg } = await import("../src/auth.js");
  const { orgMonthSpendUsd } = await import("../src/queries.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const spend = await import("../src/spend.js");
  const limits = await import("../src/limits.js");
  const A = (await createOrg(`Spend A ${STAMP}`)).org, B = (await createOrg(`Spend B ${STAMP}`)).org;
  try {
    // ---------- 1. live, then recorded ----------
    assert.equal(await orgMonthSpendUsd(A.orgId), 0, "nothing spent yet");
    const r1 = await w.start(A.orgId, "metered", "user_a1");
    const c1 = (await w.claim(["metered"]))!;
    assert.equal(c1.run.id, r1.id);
    assert.deepEqual(await w.spend(c1, 2), [200, 200]);
    near(await orgMonthSpendUsd(A.orgId), 2 * PER_REQUEST_USD, "A's month figure counts its running run's live spend");
    assert.equal(await orgMonthSpendUsd(B.orgId), 0, "B's month figure is untouched");
    await w.complete(c1);
    near(await orgMonthSpendUsd(A.orgId), 2 * PER_REQUEST_USD, "and its recorded cost once it completed");
    console.log("✓ a run's spend counts in its workspace's month figure, live while it runs and recorded after; the other workspace's is untouched");

    // ---------- 2. row-level security ----------
    near(await withTenant(A.orgId, () => orgMonthSpendUsd(A.orgId)), 2 * PER_REQUEST_USD, "A's own figure, under A's row-level security");
    assert.equal(await withTenant(B.orgId, () => orgMonthSpendUsd(A.orgId)), 0, "scoped to B, A's run spend is invisible whatever the query asks");
    const seen = await withTenant(B.orgId, async () => w.db.query("SELECT 1 FROM gateway_usage WHERE run_id IS NOT NULL"));
    assert.equal(seen.length, 0, "B's tenant work sees none of A's run usage rows");
    const own = await withTenant(A.orgId, async () => w.db.query("SELECT 1 FROM gateway_usage WHERE run_id IS NOT NULL"));
    assert.equal(own.length, 1, "A's tenant work sees its own run's usage row");
    console.log("✓ row-level security: a workspace reads its own run spend and none of another's");

    // ---------- 3. admin spend pages and the month's pace ----------
    const rep = await spend.spendReport();
    const ra = rep.accounts.find((a) => a.slug === A.slug)!, rb = rep.accounts.find((a) => a.slug === B.slug)!;
    near((ra as { run_usd?: number }).run_usd ?? 0, 2 * PER_REQUEST_USD, "Spend page: A's run spend");
    near(ra.month_usd, 2 * PER_REQUEST_USD, "Spend page: A's month figure (Billing's) includes runs");
    near(ra.spent_usd, 2 * PER_REQUEST_USD, "Spend page: A's spend in range includes runs");
    assert.equal(rb.spent_usd, 0, "B spent nothing");
    const peek = await spend.accountSpend(A.slug);
    const who = peek.by_person.find((p) => p.user_id === "user_a1") as { run_usd?: number; usd: number } | undefined;
    assert.ok(who, "the member who started the run is on A's peek");
    near(who!.usd, 2 * PER_REQUEST_USD, "by person: the run's spend");
    near((await limits.monthFigures(A.orgId)).recent.usd, 2 * PER_REQUEST_USD, "the month's pace counts runs");
    console.log("✓ the admin Spend page (account, month figure, by person) and the month's pace count runs");

    // ---------- 4. portal pages ----------
    const ta = await w.http.signIn(A, "owner"), tb = await w.http.signIn(B, "owner");
    const get = async (t: string, p: string) => { const r = await w.http.req("GET", p, { authorization: `Bearer ${t}` }); assert.equal(r.status, 200, `${p}: ${r.status}`); return r.json() as Promise<any>; };
    const billA = await get(ta, "/api/app/billing/usage"), billB = await get(tb, "/api/app/billing/usage");
    near(billA.spent_usd, 2 * PER_REQUEST_USD, "Billing: A's spend this month includes runs");
    assert.ok(billA.runs && billA.runs.finished === 1, "Billing: A's runs");
    assert.equal(billB.spent_usd, 0); assert.equal(billB.runs, undefined, "Billing: B has no runs section");
    const useA = await get(ta, "/api/app/usage"), useB = await get(tb, "/api/app/usage");
    near(useA.spend.month_usd, 2 * PER_REQUEST_USD, "Usage: A's model spend this month includes runs");
    assert.equal(useA.run_usage?.runs, 1, "Usage: A's runs appear");
    assert.equal(useB.spend.month_usd, 0); assert.equal(useB.run_usage, undefined, "Usage: B's page has no runs section");
    assert.ok(!JSON.stringify(useB).includes(r1.id) && !JSON.stringify(billB).includes(r1.id), "B's pages never name A's run");
    console.log("✓ the portal's Usage and Billing pages count A's runs; B's pages are as before");

    // ---------- 5. budgets that read month spend ----------
    await w.db.query("UPDATE organizations SET budget_override_usd = $2 WHERE id = $1", [A.orgId, 0.3]);
    const r2 = await w.start(A.orgId, "metered", "user_a1");
    const c2 = (await w.claim(["metered"]))!;
    assert.equal(c2.run.id, r2.id);
    assert.deepEqual(await w.spend(c2, 2), [200, 429], "the gateway refuses a run's request once the account's month spend (runs included) reaches its allowance");
    await w.complete(c2);
    await assert.rejects(w.start(A.orgId, "metered"), /account has used/, "and no new run starts");
    assert.ok((await w.start(B.orgId, "metered")).id, "B, with its own month, still starts runs");
    console.log("✓ budgets: with the allowance used by runs, a new run is refused and a running run's next request gets 429");
  } finally {
    await w.close();
  }
} finally {
  cleanup();
}
process.exit(0);
