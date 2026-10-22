// Price per run under real concurrency (mold_v0-019; src/run-charges.ts), on a real Postgres (PGlite has one
// connection, so it cannot race): many priced runs, each ended by everything at once (two completions with its lease,
// a failure, an infrastructure failure that would retry it, a cancel and the lease sweep), while several deliverers
// hand charges to a Stripe stand-in that records every request. Every run must end with exactly one charge, and each
// charge must reach Stripe exactly once (one request, one identifier).
//   DATABASE_URL=postgres://... npm run test:run-charges-race
// A throwaway database only: it migrates it and adds rows.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { createMockApp } from "./lib/mock-providers.js";

if (!process.env.DATABASE_URL) { console.error("run-charges-race: set DATABASE_URL to a throwaway Postgres"); process.exit(2); }
process.env.OCTILLION_VAULT_KEY ??= randomBytes(32).toString("base64");
process.env.OCTILLION_REGISTRY ??= "scripts/fixtures/registry.json";
process.env.OCTILLION_AUTOSCALE ??= "off";
process.env.REASONS_ENABLED = "off";
process.env.OCTILLION_ORG_MONTHLY_BUDGET_USD ??= "1000";
process.env.OCTILLION_RUNS_MAX_LIVE_PER_WORKSPACE = "1000";
process.env.OCTILLION_LIMIT_RUNS_CONCURRENCY_PER_WORKSPACE = "1000";
const N = Number(process.env.RACE_N ?? 30), ROUNDS = Number(process.env.RACE_ROUNDS ?? 3);

// The Stripe stand-in, behind a recorder of every meter event request.
const sent: string[] = [];
let url = "";
const { app: mock, state: stripe } = await createMockApp(() => url);
const front = express();
front.use(express.urlencoded({ extended: true }));
front.use((req, _res, next) => { if (req.method === "POST" && req.path === "/v1/billing/meter_events") sent.push(String(req.body.identifier)); next(); });
front.use(mock);
const server = front.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_test_race", STRIPE_API_URL: url, OCTILLION_RUN_CHARGE_GRACE_SECONDS: "0" });
const post = async (p: string, body: Record<string, string>) =>
  (await fetch(`${url}${p}`, { method: "POST", headers: { authorization: "Bearer sk_test_race", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) })).json() as Promise<any>;
const meter = await post("/v1/billing/meters", { event_name: "run_charges", display_name: "Run charges" });
const product = await post("/v1/products", { name: "Runs" });
const price = (await post("/v1/prices", { product: product.id, currency: "usd", unit_amount: "1", "recurring[interval]": "month", "recurring[usage_type]": "metered", "recurring[meter]": meter.id })).id;

const { getDb } = await import("../src/db.js");
const db = await getDb();
await import("../src/server.js");
const { setPacksForTest } = await import("../src/packs.js");
const { definePack } = await import("../src/pack-api.js");
const runs = await import("../src/runs.js");
const rc = await import("../src/run-charges.js");
const billing = await import("../src/billing.js");
const { createOrg } = await import("../src/auth.js");
rc.setBillingForTest({ enabled: true, currency: "usd", charge_failed_runs: true, charge_cancelled_runs: true });
setPacksForTest([{ manifest: { id: "fixture_charges", name: "Charges", version: "1", entry: "index.ts", migrations: null, words: {}, dir: "scripts/fixtures/runs" },
  definition: definePack({ id: "fixture_charges", jobKinds: [{ name: "priced", runner: "workspace-harness", entry: "ok.mjs", max_attempts: 2,
    price: { currency: "usd", fixed: 1.25, on_failure: "full" } }] as never }) }]);

let total = 0;
for (let round = 0; round < ROUNDS; round++) {
  const { org } = await createOrg(`Charges race ${Date.now().toString(36)} ${round}`);
  const cus = (await billing.createCustomer({ name: org.name, slug: org.slug })).id;
  await db.query("UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1", [org.orgId, cus]);
  await fetch(`${url}/_mock/subscriptions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customer: cus, price, invoice: false }) });
  const ids: string[] = [];
  for (let i = 0; i < N; i++) ids.push((await runs.startRun(org.orgId, "fixture_charges", "priced")).id);
  const claims = [];
  for (let c = await runs.claimRun("w-race", { kinds: ["fixture_charges/priced"] }); c; c = await runs.claimRun("w-race", { kinds: ["fixture_charges/priced"] })) claims.push(c);
  assert.equal(claims.length, N, `claimed every run (${claims.length} of ${N})`);
  // A third of the runs: their lease has lapsed, so the sweep races to end them too.
  await db.query("UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = ANY($1)", [ids.filter((_, i) => i % 3 === 0)]);
  // Everything at once, for every run.
  await Promise.allSettled(claims.flatMap((c, i) => [
    runs.completeRun(c.run.id, c.lease_token, { outcome: "succeeded", results: [] }),
    runs.completeRun(c.run.id, c.lease_token, { outcome: "succeeded", results: [] }),
    runs.completeRun(c.run.id, c.lease_token, { outcome: "failed", error_kind: i % 2 ? "infrastructure" : "run", error: "race" }),
    ...(i % 4 === 1 ? [runs.cancelRun(org.orgId, c.run.id)] : []),
    runs.sweepRuns(),
    rc.deliverCharges(), rc.deliverCharges(),
  ]));
  // Runs an infrastructure failure or the sweep put back in the queue: their next attempt ends them, with deliverers racing.
  for (let c = await runs.claimRun("w-race", { kinds: ["fixture_charges/priced"] }); c; c = await runs.claimRun("w-race", { kinds: ["fixture_charges/priced"] }))
    await Promise.allSettled([runs.completeRun(c.run.id, c.lease_token, { outcome: "succeeded", results: [] }), runs.completeRun(c.run.id, c.lease_token, { outcome: "succeeded", results: [] }), rc.deliverCharges()]);
  await Promise.all([rc.deliverCharges(), rc.deliverCharges(), rc.deliverCharges()]);
  for (let i = 0; i < 100; i++) {
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_charges WHERE org_id = $1 AND delivery = 'pending'", [org.orgId]);
    if (!n) break;
    await new Promise((r) => setTimeout(r, 100));
    await rc.deliverCharges();
  }
  const st = await db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM runs WHERE id = ANY($1) GROUP BY 1 ORDER BY 1", [ids]);
  assert.ok(st.every((x) => ["succeeded", "failed", "cancelled"].includes(x.status)), `every run ended: ${JSON.stringify(st)}`);
  const per = await db.query<{ run_id: string; n: number; paid: number }>(
    "SELECT run_id, count(*)::int AS n, count(*) FILTER (WHERE amount_minor > 0)::int AS paid FROM run_charges WHERE org_id = $1 AND kind = 'charge' GROUP BY 1", [org.orgId]);
  assert.equal(per.length, N, `every run has a charge (${per.length} of ${N})`);
  assert.ok(per.every((x) => x.n === 1), "and exactly one");
  const paid = await db.query<{ run_id: string }>("SELECT run_id FROM run_charges WHERE org_id = $1 AND kind = 'charge' AND amount_minor > 0", [org.orgId]);
  for (const p of paid) {
    const n = sent.filter((x) => x === `run_charge:${p.run_id}`).length;
    assert.equal(n, 1, `the charge of ${p.run_id} was sent to Stripe once (${n})`);
  }
  const counted = stripe.meterEvents.filter((e: { identifier: string }) => paid.some((p) => e.identifier === `run_charge:${p.run_id}`)).length;
  assert.equal(counted, paid.length, "Stripe counted each paid charge once");
  total += N;
  console.log(`round ${round + 1}: ${N} runs, each ended by everything at once -> ${per.length} charges (${paid.length} paid, ${st.map((x) => `${x.n} ${x.status}`).join(", ")}), ${paid.length} meter events`);
}
await db.close();
server.close();
console.log(`RUN CHARGES RACE PASS: ${total} runs, each charged exactly once and sent to Stripe exactly once`);
process.exit(0);
