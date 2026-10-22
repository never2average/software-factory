// Price per run (mold_v0-019; src/run-charges.ts, sql/migrations/0014_run_charges.sql), offline: an embedded database,
// the real gateway in front of a fake model ($0.12 a request), two workspaces, and the product's Stripe stand-in
// (scripts/lib/mock-providers.ts) behind a recorder of every request it gets. Nothing reaches Stripe itself.
//   npm run test:run-charges
//
//  1. Off by default: with no billing in the profile a priced kind's runs carry no price and write no charge, nothing
//     is sent to Stripe, and the Billing page, the Revenue report and the cron answer are exactly as before.
//  2. On: a succeeded run is charged its fixed amount plus its metered model cost and the percent; a failed or
//     cancelled run as its price says and the profile allows; a run the platform failed never; a pack's price is
//     clamped to the profile's ceilings, refused in another currency, and frozen when the run is queued.
//  3. Exactly once: an attempt retried after an infrastructure failure charges once (the last attempt); completions,
//     a cancel and the lease sweep racing on one run write one charge; concurrent deliverers send each charge once;
//     a resend after a lost answer carries the same identifier and idempotency key (Stripe counts it once); the
//     reconcile backstop writes a missing charge once.
//  4. Two workspaces: each charge goes to its own workspace's Stripe customer (or the ledger, with none); under
//     row-level security a workspace reads its own charges only and writes none; each Billing page shows its own.
//  5. Credits: staff credit a charged run once (to the customer's Stripe balance, keyed by the run), never a free run
//     and never twice; viewers may not. The admin Revenue report and the Run charges list show charges and credits.
//  6. The profile: gen-packs takes `billing` from profile.json, refuses a typo, and refuses it from a host pack's profile.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { cleanup, STAMP } from "./lib/test-world.js";
import { PER_REQUEST_USD, spendWorld } from "./lib/spend-world.js";
import { createMockApp } from "./lib/mock-providers.js";

// ---------- the Stripe stand-in, behind a recorder ----------
const posted: { path: string; key: string | undefined; body: Record<string, any> }[] = [];
let meterDown = false;
let stripeUrl = "";
const { app: mockApp, state: stripe } = await createMockApp(() => stripeUrl);
const front = express();
front.use(express.urlencoded({ extended: true }));
front.use((req, res, next) => {
  if (req.method === "POST" && (req.path === "/v1/billing/meter_events" || /^\/v1\/customers\/[^/]+\/balance_transactions$/.test(req.path))) {
    posted.push({ path: req.path, key: req.get("idempotency-key"), body: req.body });
    if (meterDown && req.path === "/v1/billing/meter_events") return void res.status(500).json({ error: { message: "Stripe is having trouble (test)" } });
  }
  next();
});
front.use(mockApp);
const stripeServer = front.listen(0, "127.0.0.1");
await new Promise((r) => stripeServer.once("listening", r));
stripeUrl = `http://127.0.0.1:${(stripeServer.address() as AddressInfo).port}`;
Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_test_runcharges", STRIPE_API_URL: stripeUrl, CRON_SECRET: "cron-test-secret" });
const meterPosts = (run?: string) => posted.filter((p) => p.path === "/v1/billing/meter_events" && (!run || p.body.identifier === `run_charge:${run}`));

const RULES = { enabled: true, currency: "usd", max_fixed: 10, max_cost_plus_percent: 100, charge_failed_runs: true, charge_cancelled_runs: true };
try {
  const w = await spendWorld([
    { name: "flat", budget_usd: 5, price: { currency: "usd", fixed: 2.5 } },
    { name: "plus", providers: ["anthropic"], budget_usd: 5, max_attempts: 3, price: { currency: "usd", fixed: 1, cost_plus_percent: 50, on_failure: "cost", on_cancel: "cost" } },
    { name: "full", providers: ["anthropic"], budget_usd: 5, max_attempts: 1, price: { currency: "usd", fixed: 3, cost_plus_percent: 20, on_failure: "full" } },
    { name: "greedy", budget_usd: 5, price: { currency: "usd", fixed: 5000, cost_plus_percent: 900 } },
    { name: "euro", budget_usd: 5, price: { currency: "eur", fixed: 1 } },
    { name: "unpriced", budget_usd: 5 },
  ]);
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const rc = await import("../src/run-charges.js");
  const billing = await import("../src/billing.js");
  const A = (await createOrg(`Charges A ${STAMP}`)).org, B = (await createOrg(`Charges B ${STAMP}`)).org;
  const charges = (run: string) => w.db.query<{ kind: string; amount_minor: string; attempt: number; run_status: string; delivery: string; delivery_ref: string | null; org_id: number; reason: string | null; currency: string }>(
    "SELECT kind, amount_minor, attempt, run_status, delivery, delivery_ref, org_id, reason, currency FROM run_charges WHERE run_id = $1 ORDER BY kind", [run]);
  const charge = async (run: string) => { const c = (await charges(run)).filter((x) => x.kind === "charge"); assert.equal(c.length, 1, `exactly one charge for ${run}: ${c.length}`); return c[0]!; };
  /** Start a run of kind for org and claim it (the claim may take another queued run first: those are completed). */
  const startClaim = async (org: number, kind: string, by: string | null = null) => {
    const r = await w.start(org, kind, by);
    for (let c = await w.claim([kind]); c; c = await w.claim([kind])) { if (c.run.id === r.id) return c; await w.complete(c); }
    throw new Error(`could not claim ${r.id}`);
  };
  /** Deliver until nothing is left in flight (a run's end also hands its charge on in the background). */
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      await rc.deliverCharges();
      const [{ n }] = await w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_charges WHERE delivery = 'pending' AND delivery_error IS NULL");
      if (!n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("charges still in flight");
  };
  const fail = (c: { run: { id: string }; lease_token: string }, error_kind: "infrastructure" | "run" | "timeout") =>
    w.runs.completeRun(c.run.id, c.lease_token, { outcome: "failed", error_kind, error: "test" });
  try {
    // ---------- 1. off by default ----------
    rc.setBillingForTest(undefined); // the build's own profile: no billing
    assert.equal(rc.billingRules(), null, "the shell's profile turns no billing on");
    const ta0 = await w.http.signIn(A, "owner");
    const billOff = await (await w.http.req("GET", "/api/app/billing", { authorization: `Bearer ${ta0}` })).json() as Record<string, unknown>;
    {
      const c = await startClaim(A.orgId, "plus");
      assert.deepEqual(await w.spend(c, 1), [200]);
      await w.complete(c);
      const [row] = await w.db.query<{ price: unknown }>("SELECT price FROM runs WHERE id = $1", [c.run.id]);
      assert.equal(row!.price, null, "off: a priced kind's run carries no price");
      assert.equal((await charges(c.run.id)).length, 0, "off: no charge is written");
      assert.equal((await rc.deliverCharges()).stripe, 0);
      assert.equal(meterPosts().length, 0, "off: nothing is sent to Stripe");
      const bill = await (await w.http.req("GET", "/api/app/billing", { authorization: `Bearer ${ta0}` })).json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(bill).sort(), ["budget_source", "budget_usd", "can_manage", "customer", "enabled", "month_spend_usd", "permissions", "plans", "prepaid_allowed", "subscription"],
        "off: the Billing page's answer has exactly its fields from before");
      assert.deepEqual(Object.keys(billOff).sort(), Object.keys(bill).sort());
      const admin = await w.http.adminToken("viewer");
      const rev = await (await w.http.req("GET", "/api/admin/onboarding/spend/revenue", { authorization: `Bearer ${admin}` })).json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(rev).sort(), ["accounts", "currencies", "plans", "range", "stripe", "totals"], "off: the Revenue report has exactly its fields from before");
      const list = await (await w.http.req("GET", "/api/admin/onboarding/spend/run-charges", { authorization: `Bearer ${admin}` })).json();
      assert.deepEqual(list, { enabled: false }, "off: the Run charges list says billing is off");
      const cron = await (await w.http.req("GET", "/api/cron/autoscale", { authorization: "Bearer cron-test-secret" })).json() as Record<string, unknown>;
      assert.ok(!("run_charges" in cron), "off: the cron entry does no billing");
      assert.equal(rc.startChargeDelivery(), false, "off: the server starts no delivery loop");
      process.env.OCTILLION_RUN_BILLING = "off";
      rc.setBillingForTest(RULES);
      assert.equal(rc.billingRules(), null, "the server's environment can turn billing off whatever the profile says");
      delete process.env.OCTILLION_RUN_BILLING;
    }
    console.log("✓ off by default: no price, no charge, nothing sent; the Billing page, Revenue report and cron answer are as before");

    // ---------- 2. on: what each run is charged ----------
    rc.setBillingForTest(RULES);
    const cusA = (await billing.createCustomer({ name: A.name, slug: A.slug })).id;
    await w.db.query("UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1", [A.orgId, cusA]);
    const cents = (usd: number) => Math.round(usd * 100);
    // A succeeded fixed-price run: its fixed amount, to A's Stripe customer.
    const flat = await startClaim(A.orgId, "flat", "user_a1");
    await w.complete(flat);
    await drain();
    let ch = await charge(flat.run.id);
    assert.equal(Number(ch.amount_minor), 250, "a succeeded run pays its fixed amount");
    assert.equal(ch.delivery, "stripe");
    assert.deepEqual(meterPosts(flat.run.id).map((p) => [p.body.event_name, p.body.payload.stripe_customer_id, p.body.payload.value, p.key]),
      [["run_charges", cusA, "250", `run_charge:${flat.run.id}`]], "one meter event, for A's customer, keyed by the run");
    // Cost-plus: fixed + model cost x (1 + 50%).
    const plus = await startClaim(A.orgId, "plus");
    assert.deepEqual(await w.spend(plus, 2), [200, 200]);
    await w.complete(plus);
    ch = await charge(plus.run.id);
    assert.equal(Number(ch.amount_minor), 100 + Math.round(cents(2 * PER_REQUEST_USD) * 1.5), "fixed plus the metered model cost and its percent");
    // Failed by the run: on_failure "cost" pays the cost-plus part only; "full" pays both.
    const pf = await startClaim(A.orgId, "plus");
    assert.deepEqual(await w.spend(pf, 1), [200]);
    await fail(pf, "run");
    assert.equal(Number((await charge(pf.run.id)).amount_minor), Math.round(cents(PER_REQUEST_USD) * 1.5), "a failed run with on_failure cost: the cost-plus part");
    const ff = await startClaim(A.orgId, "full");
    assert.deepEqual(await w.spend(ff, 1), [200]);
    await fail(ff, "timeout");
    assert.equal(Number((await charge(ff.run.id)).amount_minor), 300 + Math.round(cents(PER_REQUEST_USD) * 1.2), "a failed run with on_failure full: both");
    // Failed by the platform (infrastructure, no attempts left): never charged.
    const fi = await startClaim(A.orgId, "full");
    assert.deepEqual(await w.spend(fi, 1), [200]);
    await fail(fi, "infrastructure");
    ch = await charge(fi.run.id);
    assert.equal(ch.run_status, "failed");
    assert.ok(Number(ch.amount_minor) === 0 && ch.delivery === "none" && /never charged/.test(ch.reason ?? ""), "a run the platform failed is never charged");
    // Cancelled while queued: on_cancel cost with no cost yet is 0, nothing billed.
    const q = await w.start(A.orgId, "plus");
    await w.runs.cancelRun(A.orgId, q.id);
    ch = await charge(q.id);
    assert.ok(ch.run_status === "cancelled" && Number(ch.amount_minor) === 0 && ch.delivery === "none", "a run cancelled before it spent pays nothing");
    // Cancelled while running, after spending: the cost-plus part.
    const cr = await startClaim(A.orgId, "plus");
    assert.deepEqual(await w.spend(cr, 1), [200]);
    await w.runs.cancelRun(A.orgId, cr.run.id);
    await w.complete(cr); // the runner saw cancel=true and completes: the run ends cancelled
    ch = await charge(cr.run.id);
    assert.equal(ch.run_status, "cancelled");
    assert.equal(Number(ch.amount_minor), Math.round(cents(PER_REQUEST_USD) * 1.5), "a run cancelled after spending: the cost-plus part (on_cancel cost)");
    // The profile's rules bound a pack's price: ceilings clamp it, failures and cancels are free unless allowed.
    const gr = await startClaim(A.orgId, "greedy");
    await w.complete(gr);
    const [{ price }] = await w.db.query<{ price: Record<string, unknown> }>("SELECT price FROM runs WHERE id = $1", [gr.run.id]);
    assert.deepEqual([price.fixed_minor, price.markup_percent], [1000, 100], "a pack's fixed amount and percent are clamped to the profile's ceilings");
    assert.equal(Number((await charge(gr.run.id)).amount_minor), 1000);
    rc.setBillingForTest({ ...RULES, charge_failed_runs: false, charge_cancelled_runs: false });
    const nf = await startClaim(A.orgId, "full");
    assert.deepEqual(await w.spend(nf, 1), [200]);
    await fail(nf, "run");
    assert.equal(Number((await charge(nf.run.id)).amount_minor), 0, "a failed run is free when the profile does not allow charging failures, whatever the pack says");
    const nc = await startClaim(A.orgId, "plus");
    assert.deepEqual(await w.spend(nc, 1), [200]);
    await w.runs.cancelRun(A.orgId, nc.run.id);
    await w.complete(nc);
    assert.equal(Number((await charge(nc.run.id)).amount_minor), 0, "and a cancelled one likewise");
    // Another currency than the app's: no run of the kind starts.
    await assert.rejects(w.start(A.orgId, "euro"), /priced in eur, but this app bills in usd/, "a price in another currency is refused at start");
    // Frozen at start: the rules changing while a run is queued do not change its price.
    rc.setBillingForTest(RULES);
    const frozen = await w.start(A.orgId, "greedy");
    rc.setBillingForTest({ ...RULES, max_fixed: 50 });
    let fc = await w.claim(["greedy"]);
    while (fc && fc.run.id !== frozen.id) { await w.complete(fc); fc = await w.claim(["greedy"]); }
    await w.complete(fc!);
    assert.equal(Number((await charge(frozen.id)).amount_minor), 1000, "the price frozen when the run was queued is the one charged");
    rc.setBillingForTest(RULES);
    // An unpriced kind is never charged.
    const un = await startClaim(A.orgId, "unpriced");
    await w.complete(un);
    assert.equal((await charges(un.run.id)).length, 0, "an unpriced kind's run is never charged");
    console.log("✓ on: fixed, cost-plus, failure and cancel policies, never for the platform's failures; clamped, refused in another currency, frozen at start");

    // ---------- 3. exactly once ----------
    // Retries: an infrastructure failure with attempts left requeues the run (no charge); the attempt that ends it charges once.
    const rt = await startClaim(A.orgId, "plus");
    await fail(rt, "infrastructure");
    assert.equal((await charges(rt.run.id)).length, 0, "a retried attempt charges nothing");
    let rt2 = await w.claim(["plus"]);
    while (rt2 && rt2.run.id !== rt.run.id) { await w.complete(rt2); rt2 = await w.claim(["plus"]); }
    assert.equal(rt2!.run.attempt, 2);
    await w.complete(rt2!);
    ch = await charge(rt.run.id);
    assert.equal(ch.attempt, 2, "charged once, for the attempt that ended the run");
    // A lapsed lease swept back to the queue, then succeeding: still one charge.
    const sw = await startClaim(A.orgId, "plus");
    await w.db.query("UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [sw.run.id]);
    await w.runs.sweepRuns();
    assert.equal((await charges(sw.run.id)).length, 0, "a swept, requeued run charges nothing yet");
    let sw2 = await w.claim(["plus"]);
    while (sw2 && sw2.run.id !== sw.run.id) { await w.complete(sw2); sw2 = await w.claim(["plus"]); }
    await w.complete(sw2!);
    await charge(sw.run.id);
    // Races on one run: two completions with the lease, a cancel and the sweep, all at once.
    const race = [] as string[];
    for (let i = 0; i < 6; i++) {
      const c = await startClaim(i % 2 ? A.orgId : B.orgId, "flat");
      race.push(c.run.id);
      if (i % 3 === 0) await w.db.query("UPDATE runs SET lease_expires_at = now() - interval '1 second', max_attempts = attempt WHERE id = $1", [c.run.id]);
      await Promise.allSettled([w.complete(c), w.complete(c), w.runs.cancelRun(i % 2 ? A.orgId : B.orgId, c.run.id), w.runs.sweepRuns(),
        fail(c, "run"), rc.deliverCharges(), rc.deliverCharges()]);
    }
    for (const id of race) await charge(id);
    // Concurrent deliverers: each charge is sent once.
    const before = meterPosts().length;
    await Promise.all([rc.deliverCharges(), rc.deliverCharges(), rc.deliverCharges(), rc.deliverCharges()]);
    await drain();
    const ids = meterPosts().map((p) => p.body.identifier as string);
    assert.equal(new Set(ids).size, ids.length, `concurrent deliverers sent no charge twice (${ids.length} sent, ${before} before the last round)`);
    const [{ n: pendingLeft }] = await w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_charges WHERE delivery = 'pending'");
    assert.equal(pendingLeft, 0, "every charge was handed on");
    // A lost answer: Stripe took the event, the row still says pending; the resend is the same event (Stripe counts it once).
    await w.db.query("UPDATE run_charges SET delivery = 'pending', delivered_at = NULL, delivery_ref = NULL WHERE run_id = $1 AND kind = 'charge'", [flat.run.id]);
    await drain();
    const resent = meterPosts(flat.run.id);
    assert.equal(resent.length, 2, "the charge whose answer was lost is sent again");
    assert.ok(resent.every((p) => p.key === `run_charge:${flat.run.id}` && p.body.identifier === `run_charge:${flat.run.id}`), "with the same identifier and idempotency key");
    assert.equal(stripe.meterEvents.filter((e: { identifier: string }) => e.identifier === `run_charge:${flat.run.id}`).length, 1, "so Stripe has it once");
    // B has no Stripe customer yet: its charge is kept in the ledger, never sent to anyone's customer.
    const bl = await startClaim(B.orgId, "flat");
    await w.complete(bl);
    await drain();
    assert.equal((await charge(bl.run.id)).delivery, "ledger", "with no Stripe customer, a workspace's charge is kept in the ledger");
    assert.equal(meterPosts(bl.run.id).length, 0, "and nothing is sent");
    // Stripe down: the charge stays pending with the error, backs off, and goes once Stripe is back.
    meterDown = true;
    const dn = await startClaim(B.orgId, "flat");
    const cusB = (await billing.createCustomer({ name: B.name, slug: B.slug })).id;
    await w.db.query("UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1", [B.orgId, cusB]);
    await w.complete(dn);
    await drain();
    const [down] = await w.db.query<{ delivery: string; delivery_error: string | null; claimed_until: Date | null }>("SELECT delivery, delivery_error, claimed_until FROM run_charges WHERE run_id = $1", [dn.run.id]);
    assert.ok(down!.delivery === "pending" && /trouble/.test(down!.delivery_error ?? "") && new Date(down!.claimed_until!).getTime() > Date.now(), "Stripe down: pending, with the error, backing off");
    meterDown = false;
    await rc.deliverCharges();
    assert.equal((await charge(dn.run.id)).delivery, "pending", "not before its back-off ends");
    await w.db.query("UPDATE run_charges SET claimed_until = now() - interval '1 second' WHERE run_id = $1", [dn.run.id]);
    await drain();
    assert.equal((await charge(dn.run.id)).delivery, "stripe", "then sent");
    assert.equal(stripe.meterEvents.filter((e: { identifier: string }) => e.identifier === `run_charge:${dn.run.id}`).length, 1, "once");
    // The function is a no-op for a run already charged; the backstop writes a missing charge once.
    const [{ again }] = await w.db.query<{ again: string | null }>("SELECT octillion_run_charge($1)::text AS again", [flat.run.id]);
    assert.equal(again, null, "writing a run's charge again does nothing");
    await w.db.query("DELETE FROM run_charges WHERE run_id = $1 AND kind = 'charge'", [gr.run.id]);
    assert.equal(await rc.reconcileCharges(), 1, "the backstop writes the one missing charge");
    assert.equal(await rc.reconcileCharges(), 0, "and only once");
    assert.equal(Number((await charge(gr.run.id)).amount_minor), 1000);
    console.log("✓ exactly once: retries, sweeps and racing completions charge once; concurrent deliverers and resends count once at Stripe");

    // ---------- 4. two workspaces ----------
    const all = await w.db.query<{ org_id: number; run_id: string }>("SELECT org_id, run_id FROM run_charges WHERE kind = 'charge'");
    for (const r of all) {
      const [run] = await w.db.query<{ org_id: number }>("SELECT org_id FROM runs WHERE id = $1", [r.run_id]);
      assert.equal(r.org_id, run!.org_id, "every charge is its own run's workspace's");
    }
    const sentTo = new Map(meterPosts().map((p) => [p.body.identifier as string, p.body.payload.stripe_customer_id as string]));
    for (const r of all) { const to = sentTo.get(`run_charge:${r.run_id}`); if (to) assert.equal(to, r.org_id === A.orgId ? cusA : cusB, "each charge went to its own workspace's Stripe customer"); }
    const seenByB = await withTenant(B.orgId, async () => w.db.query<{ org_id: number }>("SELECT org_id FROM run_charges"));
    assert.ok(seenByB.length > 0 && seenByB.every((r) => r.org_id === B.orgId), "under row-level security B reads its own charges only");
    await assert.rejects(withTenant(B.orgId, async () => w.db.query("/* tenant: test */ UPDATE run_charges SET amount_minor = 0 WHERE org_id = $1", [B.orgId])), /permission denied/, "and changes none of them");
    await assert.rejects(withTenant(A.orgId, async () => w.db.query("SELECT octillion_run_charge($1)", [flat.run.id])), /permission denied/, "nor writes one through the shell's function");
    const tb = await w.http.signIn(B, "owner"), ta = await w.http.signIn(A, "owner"), tm = await w.http.signIn(A, "member");
    const billA = await (await w.http.req("GET", "/api/app/billing", { authorization: `Bearer ${ta}` })).json() as any;
    const billB = await (await w.http.req("GET", "/api/app/billing", { authorization: `Bearer ${tb}` })).json() as any;
    assert.ok(billA.run_charges?.enabled && billA.run_charges.recent.length > 0, "A's Billing page shows its run charges");
    const aRuns = new Set((await w.db.query<{ run_id: string }>("SELECT run_id FROM run_charges WHERE org_id = $1", [A.orgId])).map((r) => r.run_id));
    assert.ok(billB.run_charges.recent.every((r: any) => !aRuns.has(r.run_id)) && !JSON.stringify(billB).includes(flat.run.id), "B's never names A's runs");
    const aNet = (await w.db.query<{ s: string }>("SELECT sum(amount_minor)::text AS s FROM run_charges WHERE org_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'", [A.orgId]))[0]!.s;
    assert.equal(Math.round(billA.run_charges.month[0].net * 100), Number(aNet), "A's month figure is the sum of its own charges");
    const billM = await (await w.http.req("GET", "/api/app/billing", { authorization: `Bearer ${tm}` })).json() as any;
    assert.ok(billM.run_charges.recent.every((r: any) => r.run_id !== flat.run.id), "a member sees their own runs' charges only (user_a1's are not theirs)");
    console.log("✓ two workspaces: each charge to its own customer or the ledger; each reads its own under row-level security; each Billing page its own");

    // ---------- 5. credits, and the admin pages ----------
    const viewer = await w.http.adminToken("viewer"), operator = await w.http.adminToken("operator");
    const credit = (tok: string, run: string, reason?: string) =>
      w.http.req("POST", `/api/admin/onboarding/spend/run-charges/${run}/credit`, { authorization: `Bearer ${tok}`, "x-octillion-admin": "1" }, { reason });
    assert.equal((await credit(viewer, flat.run.id, "wrong result")).status, 403, "a viewer may not credit a run");
    assert.equal((await credit(operator, flat.run.id)).status, 400, "a credit needs a reason");
    const cd = await credit(operator, flat.run.id, "wrong result");
    assert.equal(cd.status, 201, await cd.clone().text());
    await drain();
    const cRows = await charges(flat.run.id);
    assert.deepEqual(cRows.map((r) => [r.kind, Number(r.amount_minor), r.org_id]), [["charge", 250, A.orgId], ["credit", -250, A.orgId]], "one credit of minus the charge, for A");
    const txn = stripe.balanceTxns.filter((t: any) => t.metadata?.octillion_run_id === flat.run.id);
    assert.deepEqual(txn.map((t: any) => [t.customer, t.amount, t.currency]), [[cusA, -250, "usd"]], "to A's Stripe balance");
    assert.equal(posted.find((p) => p.path.endsWith("/balance_transactions") && p.body.metadata?.octillion_run_id === flat.run.id)?.key, `run_credit:${flat.run.id}`, "keyed by the run");
    assert.equal((await credit(operator, flat.run.id, "again")).status, 409, "a run is credited once");
    assert.equal((await credit(operator, q.id, "free run")).status, 409, "a run that paid nothing has nothing to credit");
    assert.equal((await credit(operator, "run_nosuchrun", "x")).status, 404);
    const rev = await (await w.http.req("GET", "/api/admin/onboarding/spend/revenue", { authorization: `Bearer ${viewer}` })).json() as any;
    const usdT = rev.run_charges.totals.find((t: any) => t.currency === "usd");
    const net = (await w.db.query<{ s: string }>("SELECT sum(amount_minor)::text AS s FROM run_charges"))[0]!.s;
    assert.equal(Math.round(usdT.net * 100), Number(net), "the Revenue report's run charges: charges less credits");
    assert.ok(rev.run_charges.accounts.some((a: any) => a.slug === A.slug) && rev.run_charges.accounts.some((a: any) => a.slug === B.slug), "per account");
    const list = await (await w.http.req("GET", `/api/admin/onboarding/spend/run-charges?account=${B.slug}`, { authorization: `Bearer ${viewer}` })).json() as any;
    assert.ok(list.rows.length > 0 && list.rows.every((r: any) => r.account.slug === B.slug), "the Run charges list, for one account");
    const cron = await (await w.http.req("GET", "/api/cron/autoscale", { authorization: "Bearer cron-test-secret" })).json() as any;
    assert.ok(cron.run_charges && typeof cron.run_charges.stripe === "number", "on: the cron entry hands pending charges on");
    console.log("✓ credits once, to the right customer, operators only; the Revenue report and the Run charges list show charges and credits");

    // ---------- 6. the profile ----------
    const dir = mkdtempSync(path.join(tmpdir(), "charges-gen-"));
    try {
      mkdirSync(path.join(dir, "packs")); mkdirSync(path.join(dir, "out"));
      const gen = (profile: unknown) => {
        writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile));
        return spawnSync(process.execPath, ["scripts/gen-packs.mjs", "--packs", path.join(dir, "packs"), "--out", path.join(dir, "out"), "--profile", path.join(dir, "profile.json")],
          { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
      };
      const good = gen({ name: "Shell", billing: { enabled: true, currency: "eur", max_fixed: 20, charge_failed_runs: true } });
      assert.equal(good.status, 0, good.stderr);
      assert.ok(readFileSync(path.join(dir, "out", "src", "profile.generated.ts"), "utf8").includes('"currency": "eur"'), "the profile's billing reaches the server's generated profile");
      assert.ok(!readFileSync(path.join(dir, "out", "web", "src", "config", "profile.generated.ts"), "utf8").includes("billing"), "and never the console's");
      for (const bad of [{ enabled: "yes" }, { enabled: true, currency: "EUR" }, { enabled: true, max_fixed: -1 }, { enabled: true, charge_failed: true }, []]) {
        const r = gen({ name: "Shell", billing: bad });
        assert.ok(r.status !== 0 && /billing/.test(r.stderr), `gen-packs refuses billing ${JSON.stringify(bad)}`);
      }
      // A host pack's profile may not turn billing on.
      const pk = path.join(dir, "packs", "host_biller");
      mkdirSync(pk);
      writeFileSync(path.join(pk, "pack.json"), JSON.stringify({ id: "host_biller", name: "Host biller", version: "1", host: { entry: "host.ts", profile: { billing: { enabled: true } } } }));
      writeFileSync(path.join(pk, "host.ts"), "export default {};\n");
      const host = gen({ name: "Shell", host_packs: ["host_biller"] });
      assert.ok(host.status !== 0 && /may not set billing/.test(host.stderr), `a host pack's profile may not set billing: ${host.stderr.slice(0, 300)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    console.log("✓ the profile: billing from profile.json only, checked by gen-packs, never in the console's copy");
  } finally {
    rc.setBillingForTest(undefined);
    await w.close();
  }
} finally {
  stripeServer.close();
  cleanup();
}
console.log("RUN CHARGES TEST PASS");
process.exit(0);
