// Upgrade plan for this month (mold_v0-342, flag plan_upgrade; src/month-upgrade.ts), offline: an embedded database, a
// fake sign-in and the payment provider's stand-in (scripts/lib/mock-providers.ts). Run by `npm run test:month-upgrade`.
//   1. Off (the default): GET and POST /api/app/billing/upgrade answer not found; invitations are not counted against
//      seats; the allowance is as before.
//   2. Roles: a viewer and a plain member are refused (403) reading and saving; a billing manager and an owner may.
//   3. Validation: seats a whole number from 1 to 10,000 and at least the people and pending invitations; this month's
//      limit from $0 to $1,000,000 and at least the month's spend so far; nothing to change is refused.
//   4. Billing off (the ledger only): the change applies, says no payment was taken, sets the month's allowance
//      (orgBudget source "month", the Billing page's budget), adds one Budget rules history line and marks the
//      allowance's row as changed; an invitation past the seats is refused, one within them goes out.
//   5. Month only: the change holds for its own month (UTC) and never another; once its month has passed the plan's or
//      the default allowance applies again and the seats are no longer checked.
//   6. Payment provider on: a raise with no plan is refused (choose a plan first) and writes nothing; with a live plan it
//      answers the provider's billing page and writes nothing (the allowance unchanged, nothing charged here); a lowering
//      applies; the plan's seats come from its product's metadata.
//   7. The page (source assertions): This month is the Spending tab's first section, above the spend analytics, and no
//      longer above the strip when the pack has a Spending tab; Upgrade plan only with the flag and for billing roles;
//      the dialog saves through POST /billing/upgrade and shows now → new.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);

try {
  const F = await import("../src/features.js");
  const { createOrg } = await import("../src/auth.js");
  const { getDb } = await import("../src/db.js");
  const billing = await import("../src/billing.js");
  const mu = await import("../src/month-upgrade.js");
  const { KEY_PREFIX } = await import("../src/namespace.js");
  const db = await getDb();
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const W = (await createOrg(`Upgrade ${STAMP}`)).org;
  const own = await http.signInAs(W, "owner");
  const bill = await http.signInAs(W, "billing");
  const member = await http.signInAs(W, "member");
  const viewer = await http.signInAs(W, "viewer");
  const h = (t: string) => ({ authorization: `Bearer ${t}` });
  const app = async (tok: string, method: string, p: string, body?: unknown) => {
    const r = await http.req(method, `/api/app${p}`, h(tok), body);
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const rows = () => db.query<{ seats: number | null; limit_usd: string | null; period_start: Date; period_end: Date }>(
    "SELECT seats, limit_usd, period_start, period_end FROM billing_month_changes WHERE org_id = $1 ORDER BY period_start", [W.orgId]);
  const budget = () => billing.orgBudget(W.orgId);

  // ---------- 1. off ----------
  {
    F.setFeaturesForTest({});
    assert.equal(F.featureOn("plan_upgrade"), false, "off by default");
    assert.equal((await app(own.token, "GET", "/billing/upgrade")).status, 404, "GET: not found while off");
    assert.equal((await app(own.token, "POST", "/billing/upgrade", { seats: 9 })).status, 404, "POST: not found while off");
    assert.deepEqual(await budget(), { budget: 1000, subscription: null, source: "default" }, "the allowance as before");
    ok("off: the routes answer not found and the allowance is as before");
  }
  F.setFeaturesForTest({ plan_upgrade: true });

  // ---------- 2. roles ----------
  {
    for (const [who, t] of [["a viewer", viewer.token], ["a plain member", member.token]] as const) {
      const g = await app(t, "GET", "/billing/upgrade"), p = await app(t, "POST", "/billing/upgrade", { limit_usd: 2000 });
      assert.equal(g.status, 403, `${who} may not read it`);
      assert.equal(p.status, 403, `${who} may not save it`);
      assert.match(p.body.error, /Billing manager role/, "in plain words");
    }
    assert.equal((await rows()).length, 0, "nothing written by a refused save");
    const v = await app(bill.token, "GET", "/billing/upgrade");
    assert.equal(v.status, 200, "a billing manager may");
    assert.equal(v.body.payment, "ledger", "billing is off here: the ledger only");
    assert.deepEqual(v.body.seats, { now: null, plan: null, members: 4, invitations: 0 }, "no seats yet; four people");
    assert.deepEqual(v.body.limit, { now_usd: 1000, plan_usd: 1000, spent_usd: 0 });
    assert.equal(v.body.plan, null);
    assert.equal((await app(own.token, "GET", "/billing/upgrade")).status, 200, "an owner may");
    ok("roles: a viewer and a plain member are refused reading and saving; billing managers and owners may");
  }

  // ---------- 3. validation ----------
  {
    // This month's spend so far: one run of $12.34.
    await db.query(`INSERT INTO runs (id, org_id, pack, kind, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, cost_usd, status)
                    VALUES ($1, $2, 'fixture', 'echo', '{}', 1, 600, 60, 5, 12.34, 'succeeded')`, [`run_up_${STAMP}`, W.orgId]);
    const bad = async (body: unknown, re: RegExp, extra?: Record<string, unknown>) => {
      const r = await app(own.token, "POST", "/billing/upgrade", body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, re);
      if (extra) for (const [k, x] of Object.entries(extra)) assert.equal(r.body[k], x, k);
    };
    await bad({ seats: 0 }, /whole number from 1 to 10,000/);
    await bad({ seats: 2.5 }, /whole number/);
    await bad({ seats: 10_001 }, /whole number from 1 to 10,000/);
    await bad({ seats: 3 }, /has 4 people: choose at least 4 seats/, { min_seats: 4 });
    await bad({ limit_usd: -1 }, /from \$0 to \$1,000,000/);
    await bad({ limit_usd: 1_000_001 }, /from \$0 to \$1,000,000/);
    await bad({ limit_usd: "lots" }, /from \$0/);
    await bad({ limit_usd: 12 }, /already \$12\.34: the limit can't be lower/, { min_limit_usd: 12.34 });
    await bad({}, /Choose a seat count or this month's limit/);
    await bad({ limit_usd: 1000 }, /Nothing to change/);
    assert.equal((await rows()).length, 0, "nothing written by a refused save");
    ok("validation: seats 1 to 10,000 and at least the people there; the limit $0 to $1,000,000 and at least the month's spend; nothing to change refused");
  }

  // ---------- 4. billing off: applied, audited, seats enforced ----------
  {
    const r = await app(bill.token, "POST", "/billing/upgrade", { seats: 5, limit_usd: 250 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "applied");
    assert.match(r.body.message, /^Saved for this month only, until \d+ \w+\. No payment was taken: billing is off in this app/);
    assert.deepEqual([r.body.view.seats.now, r.body.view.limit.now_usd, r.body.view.limit.plan_usd], [5, 250, 1000], "the dialog's new view");
    const [row] = await rows();
    const { start, end } = mu.monthPeriod();
    assert.deepEqual([row!.seats, Number(row!.limit_usd), row!.period_start.toISOString(), row!.period_end.toISOString()], [5, 250, start.toISOString(), end.toISOString()],
      "one change, with its month");
    assert.deepEqual(await budget(), { budget: 250, subscription: null, source: "month" }, "this month's allowance is the limit");
    const b = await app(own.token, "GET", "/billing");
    assert.deepEqual([b.body.budget_usd, b.body.budget_source], [250, "month"], "the Billing page says so");
    assert.equal((await app(own.token, "GET", "/billing/usage")).body.budget_usd, 250, "and This month's bar");
    // The audit line: Budget rules' history, and the allowance's row marked as changed by whom.
    const hist = await app(own.token, "GET", "/limits/history");
    const line = hist.body.entries[0];
    assert.match(line.summary, /^This month only \(until \d+ \w+\): seats no limit → 5, limit \$1000 → \$250; no payment taken \(billing is off\)$/, line.summary);
    const lim = await app(own.token, "GET", "/limits");
    assert.ok(lim.body.changed.allowance, "the allowance's row: who set it and when");
    assert.equal(lim.body.budget_usd, 250, "Budget rules' allowance is this month's");
    // Seats: 4 people, 5 seats: one invitation goes out, the next is refused.
    const inv1 = await app(own.token, "POST", "/team/invitations", { email: `fifth-${STAMP}@example.org` });
    assert.equal(inv1.status, 201, JSON.stringify(inv1.body));
    const inv2 = await app(own.token, "POST", "/team/invitations", { email: `sixth-${STAMP}@example.org` });
    assert.equal(inv2.status, 409, JSON.stringify(inv2.body));
    assert.equal(inv2.body.code, "seats_full");
    assert.match(inv2.body.error, /All 5 seats are taken \(people and pending invitations\)\. An owner or billing manager can add seats for this month with Upgrade plan on Billing\./);
    // The pending invitation counts: seats can't go below 5 now.
    const low = await app(own.token, "POST", "/billing/upgrade", { seats: 4 });
    assert.equal(low.status, 400);
    assert.match(low.body.error, /4 people and 1 pending invitation: choose at least 5 seats/);
    // More seats, then the invitation goes out; the history says what changed only.
    assert.equal((await app(own.token, "POST", "/billing/upgrade", { seats: 6 })).body.status, "applied");
    assert.equal((await app(own.token, "POST", "/team/invitations", { email: `sixth-${STAMP}@example.org` })).status, 201, "within the new seats");
    assert.match((await app(own.token, "GET", "/limits/history")).body.entries[0].summary, /: seats 5 → 6; no payment taken/, "only the seats changed");
    assert.equal((await rows()).length, 1, "still one change for the month (updated)");
    ok("billing off: applied with no payment taken; the month's allowance everywhere; one history line each, the allowance's row marked; invitations stop at the seats");
  }

  // ---------- 5. month only ----------
  {
    const next = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 3));
    assert.equal(await mu.currentChange(W.orgId, next), null, "next month has no change: it ends with its own");
    const prev = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 20));
    assert.equal(await mu.currentChange(W.orgId, prev), null, "nor did last month");
    // A change made in another month is its own row, and does not touch this one.
    await mu.apply({ orgId: W.orgId, slug: W.slug }, { label: "customer:test", user: own.userId }, { limit_usd: 300 }, next);
    assert.equal((await rows()).length, 2);
    assert.equal((await mu.currentChange(W.orgId))!.limit_usd, 250, "this month's is still 250");
    assert.equal((await mu.currentChange(W.orgId, next))!.limit_usd, 300, "next month's is its own");
    await db.query("DELETE FROM billing_month_changes WHERE org_id = $1 AND period_start > now()", [W.orgId]);
    // This month passes: its change is a month behind now.
    await db.query("UPDATE billing_month_changes SET period_start = period_start - interval '1 month', period_end = period_start WHERE org_id = $1", [W.orgId]);
    assert.deepEqual(await budget(), { budget: 1000, subscription: null, source: "default" }, "the default allowance applies again");
    assert.equal((await app(own.token, "GET", "/billing")).body.budget_source, "default");
    const v = (await app(own.token, "GET", "/billing/upgrade")).body;
    assert.deepEqual([v.seats.now, v.limit.now_usd, v.change], [null, 1000, null], "no seats and the plan's limit again");
    assert.equal((await app(own.token, "POST", "/team/invitations", { email: `seventh-${STAMP}@example.org` })).status, 201, "seats no longer checked");
    await db.query("DELETE FROM billing_month_changes WHERE org_id = $1", [W.orgId]);
    ok("month only: a change holds for its own month and never another; once it has passed, the allowance and seats are the plan's again");
  }

  // ---------- 6. the payment provider on ----------
  {
    Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_test_mock", STRIPE_API_URL: http.mock.url });
    billing.invalidatePlans(); billing.invalidateSubscriptions();
    const stripe = async (p: string, body: Record<string, string>) =>
      (await fetch(`${http.mock.url}${p}`, { method: "POST", headers: { authorization: "Bearer sk_test_mock", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) })).json() as Promise<any>;
    // No plan yet: a raise is refused, nothing written.
    const none = await app(own.token, "POST", "/billing/upgrade", { limit_usd: 2000 });
    assert.equal(none.status, 409, JSON.stringify(none.body));
    assert.equal(none.body.code, "needs_plan");
    assert.match(none.body.error, /no plan yet: choose one under This month first/);
    assert.equal((await rows()).length, 0);
    // A live plan of $49 a month with a $100 allowance and 8 seats (its product's metadata).
    const prod = await stripe("/v1/products", { name: "Team", "metadata[seats]": "8", "metadata[monthly_budget_usd]": "100" });
    const price = await stripe("/v1/prices", { product: prod.id, currency: "usd", unit_amount: "4900", "recurring[interval]": "month", lookup_key: `${KEY_PREFIX}team_${STAMP}` });
    const cus = await stripe("/v1/customers", { name: W.name });
    await db.query("UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1", [W.orgId, cus.id]);
    await fetch(`${http.mock.url}/_mock/subscriptions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customer: cus.id, price: price.id, invoice: false }) });
    billing.invalidatePlans(); billing.invalidateSubscriptions();
    const v = (await app(own.token, "GET", "/billing/upgrade")).body;
    assert.equal(v.payment, "provider");
    assert.deepEqual([v.seats.plan, v.seats.now, v.limit.plan_usd, v.limit.now_usd], [8, 8, 100, 100], "the plan's seats (its product's metadata) and allowance");
    assert.deepEqual(v.plan, { name: "Team", amount: 4900, currency: "usd", interval: "month" }, "its price, for the dialog");
    // A raise: the provider's billing page; nothing written, the allowance unchanged.
    const up = await app(bill.token, "POST", "/billing/upgrade", { seats: 12, limit_usd: 500 });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.status, "provider");
    assert.equal(up.body.url, `${http.mock.url}/billing/${cus.id}`, "the provider's billing page for this customer");
    assert.match(up.body.message, /Nothing changes or is charged until you confirm it there/);
    assert.equal((await rows()).length, 0, "nothing written");
    assert.deepEqual([(await budget()).budget, (await budget()).source], [100, "plan"], "the allowance is the plan's still");
    assert.equal((await app(bill.token, "POST", "/billing/upgrade", { seats: 12 })).body.status, "provider", "more seats alone too");
    // A lowering costs nothing: it applies.
    const down = await app(bill.token, "POST", "/billing/upgrade", { limit_usd: 50 });
    assert.equal(down.body.status, "applied", JSON.stringify(down.body));
    assert.match(down.body.message, /Nothing is charged: it lowers what this month may use\./);
    assert.deepEqual([(await budget()).budget, (await budget()).source], [50, "month"]);
    assert.match((await app(own.token, "GET", "/limits/history")).body.entries[0].summary, /^This month only \(until \d+ \w+\): limit \$100 → \$50$/, "no ledger words with the provider on");
    // Seats from the plan: 4 people and 3 invitations of 8, one more goes out, then full.
    assert.equal((await app(own.token, "POST", "/team/invitations", { email: `eighth-${STAMP}@example.org` })).status, 201);
    assert.equal((await app(own.token, "POST", "/team/invitations", { email: `ninth-${STAMP}@example.org` })).body.code, "seats_full", "the plan's 8 seats");
    delete process.env.STRIPE_SECRET_KEY;
    ok("payment provider on: a raise with no plan refused, with a plan the provider's billing page and nothing written or charged; a lowering applies; the plan's seats count");
  }

  // ---------- 7. the page ----------
  {
    const src = readFileSync(path.join(ROOT, "web/src/features/portal/billing.tsx"), "utf8");
    assert.match(src, /\{!spendingTab && month\}/, "This month above the strip only without a Spending tab");
    assert.match(src, /<TabsContent value='spending'><div className='flex flex-col gap-8' data-billing-spending=''>\{month\}<WorkspaceActivityBody \/><\/div><\/TabsContent>/,
      "This month is the Spending tab's first section, the spend analytics below it");
    assert.match(src, /const canUpgrade = featureOn\('plan_upgrade'\) && b\.can_manage;/, "Upgrade plan only with the flag, for billing roles");
    assert.match(src, /\{canUpgrade && <Button size='sm' [^\n]*data-billing-upgrade=''><Icons\.rocket \/> Upgrade plan<\/Button>\}/, "a primary button in the header row");
    assert.match(src, /appApi<UpgradeAnswer>\('POST', '\/billing\/upgrade'/, "the dialog saves through the server");
    assert.match(src, /if \(r\.status === 'provider'\) \{ toast\(r\.message\); window\.location\.href = r\.url; return; \}/, "a raise with the provider opens its page");
    assert.match(src, /data-billing-upgrade-changes=''/, "what changes, now → new");
    ok("the page: This month first in Spending (analytics below), not above the strip; Upgrade plan for billing roles with the flag; the dialog saves through the server");
  }
  await http.close();
} finally {
  cleanup();
}
process.exit(0);
