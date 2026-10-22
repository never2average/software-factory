/**
 * Price per run (mold_v0-019; sql/migrations/0014_run_charges.sql, molds/mold_v0/MOLD.md "Price per run"): a billing
 * usage event per finished run, off by default.
 *
 *   rules     the app's profile.json `billing` (src/profile.ts ProfileBilling) turns it on; absent or `enabled: false`,
 *             nothing here does anything and every run's price is NULL. OCTILLION_RUN_BILLING=off turns it off again on a
 *             server (the environment can only turn it off, never on).
 *   price     a pack declares one per job kind (src/pack-api.ts RunPriceSchema). At start (src/runs.ts startRun) the
 *             platform freezes what it allows into runs.price: the app's currency only, the fixed amount and the
 *             percent clamped to the profile's ceilings, a failed or cancelled run free unless the profile allows
 *             charging it. Nothing a pack's code, a runner or a workspace sends changes it afterwards.
 *   charge    exactly one per run: a trigger on runs writes it in the same transaction as the run's move into an ended
 *             state, whichever code path moved it (completion, the lease sweep, a cancel, a launch that never
 *             happened), from the frozen price and the run's metered model cost. Retries of an attempt never end the run,
 *             so they never charge; the unique (run_id, kind) makes any second write a no-op.
 *   delivery  each charge is an outbox row, sent by the server's loop (every minute) and the cron entry once the run
 *             has been over for a grace period (late model usage is refreshed into it first): to Stripe metered billing
 *             (one meter event, identifier and idempotency key the run's own) when the workspace has a Stripe customer
 *             with a live subscription priced on the meter; else this ledger is the record. Each row is claimed alone
 *             just before it is sent, so two deliverers never send it at once; were an answer lost, the resend carries
 *             the same identifier and key and Stripe counts it once. Failures back off and are retried (20 tries).
 *   credit    staff may give a charge back once (admin FinOps › Run charges): a credit row of minus the charge, to the
 *             customer's Stripe balance (idempotency key the run's own) when the charge went to Stripe, else the ledger.
 *
 * Every read names the workspace (org_id) and, inside withTenant, also runs under row-level security: tenant work
 * reads its own workspace's charges only and writes none.
 */
import { getDb } from "./db.js";
import { PackError, RunPriceSchema, z } from "./pack-api.js";
import { PROFILE, type ProfileBilling } from "./profile.js";
import { asPlatform } from "./tenant-scope.js";

/** The app's billing rules in force (defaults filled in), or null when billing is off. */
export interface BillingRules {
  currency: string; exponent: number; max_fixed: number; max_cost_plus_percent: number;
  charge_failed_runs: boolean; charge_cancelled_runs: boolean; stripe_meter: string;
}

let testRules: ProfileBilling | null | undefined;
/** Tests only: billing rules in place of the profile's (undefined: the profile's again). */
export function setBillingForTest(b: ProfileBilling | null | undefined) { testRules = b; }

/** Currencies Stripe counts in whole units, and those in thousandths; every other in hundredths. */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
export const exponentOf = (currency: string) => (ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2);

export function billingRules(): BillingRules | null {
  if ((process.env.OCTILLION_RUN_BILLING ?? "").trim().toLowerCase() === "off") return null;
  const b = testRules !== undefined ? testRules : (PROFILE as { billing?: ProfileBilling }).billing;
  if (!b || b.enabled !== true) return null;
  const currency = /^[a-z]{3}$/.test(String(b.currency ?? "")) ? String(b.currency) : "usd";
  const bounded = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt);
  return {
    currency, exponent: exponentOf(currency),
    max_fixed: bounded(b.max_fixed, 1000), max_cost_plus_percent: bounded(b.max_cost_plus_percent, 100),
    charge_failed_runs: b.charge_failed_runs === true, charge_cancelled_runs: b.charge_cancelled_runs === true,
    stripe_meter: /^[a-z0-9_]{3,100}$/.test(String(b.stripe_meter ?? "")) ? String(b.stripe_meter) : "run_charges",
  };
}
export const runBillingOn = () => billingRules() !== null;

/** What a run's row carries (runs.price): the price the platform allowed when it was queued. */
export interface FrozenPrice {
  currency: string; exponent: number; fixed_minor: number; markup_percent: number | null;
  on_failure: "free" | "cost" | "full"; on_cancel: "free" | "cost";
}

/**
 * The price to freeze into a run of `kind` queued now, or null (billing off, or the kind has none). A price in another
 * currency than the app's is the pack's mistake: no run of the kind starts until it is fixed (a run must never go
 * unpriced, or priced in a currency the app does not bill in).
 */
export function priceForStart(kind: { pack: string; name: string; price?: unknown }): FrozenPrice | null {
  const rules = billingRules();
  if (!rules || kind.price === undefined || kind.price === null) return null;
  const parsed = RunPriceSchema.safeParse(kind.price);
  if (!parsed.success) throw new PackError(`run kind ${kind.pack}/${kind.name} has a price this build cannot read: ${z.prettifyError(parsed.error).slice(0, 300)}`, 409);
  const p = parsed.data;
  if (p.currency !== rules.currency)
    throw new PackError(`run kind ${kind.pack}/${kind.name} is priced in ${p.currency}, but this app bills in ${rules.currency}: no run of it can start until its price is fixed`, 409);
  const scale = 10 ** rules.exponent;
  return {
    currency: rules.currency, exponent: rules.exponent,
    fixed_minor: Math.max(0, Math.round(Math.min(p.fixed ?? 0, rules.max_fixed) * scale)),
    markup_percent: p.cost_plus_percent === undefined ? null : Math.min(p.cost_plus_percent, rules.max_cost_plus_percent),
    // A failed or cancelled run is charged only as far as the app allows; otherwise it is free whatever the pack says.
    on_failure: rules.charge_failed_runs ? p.on_failure : "free",
    on_cancel: rules.charge_cancelled_runs ? p.on_cancel : "free",
  };
}

// ---------- the ledger rows ----------

export interface ChargeRow {
  id: string; run_id: string; org_id: number; kind: "charge" | "credit"; pack: string; job_kind: string; attempt: number; run_status: string;
  requested_by: string | null; currency: string; amount_minor: string | number; fixed_minor: string | number; cost_minor: string | number;
  model_cost_usd: string | number; reason: string | null; credited_by: string | null; delivery: "pending" | "stripe" | "ledger" | "none";
  delivery_ref: string | null; delivery_error: string | null; delivery_attempts: number; created_at: Date | string; delivered_at: Date | string | null;
}
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
/** A row as the pages show it: amounts in minor units and in major units, never another workspace's. */
export const chargeView = (r: ChargeRow) => {
  const exp = exponentOf(r.currency);
  return {
    id: String(r.id), run_id: r.run_id, kind: r.kind, pack: r.pack, job_kind: r.job_kind, attempt: Number(r.attempt), run_status: r.run_status,
    requested_by: r.requested_by, currency: r.currency, amount_minor: Number(r.amount_minor), amount: Number(r.amount_minor) / 10 ** exp,
    fixed_minor: Number(r.fixed_minor), cost_minor: Number(r.cost_minor), model_cost_usd: Number(r.model_cost_usd), reason: r.reason,
    delivery: r.delivery, delivery_error: r.delivery_error, delivery_note: r.delivery === "ledger" ? r.delivery_ref : null, created_at: iso(r.created_at)!, delivered_at: iso(r.delivered_at),
  };
};
export type ChargeView = ReturnType<typeof chargeView>;
const COLS = `id, run_id, org_id, kind, pack, job_kind, attempt, run_status, requested_by, currency, amount_minor, fixed_minor, cost_minor, model_cost_usd,
  reason, credited_by, delivery, delivery_ref, delivery_error, delivery_attempts, created_at, delivered_at`;

/**
 * Write the charge of every ended, priced run that has none (the trigger's backstop: it logs and skips a charge it
 * could not write rather than failing the run's own change). One run at a time, so one that cannot be charged (its
 * error is logged) never holds up the rest. Returns how many were written.
 */
export async function reconcileCharges(limit = 200): Promise<number> {
  const ids = await asPlatform(async () => (await getDb()).query<{ id: string }>(
    `/* tenant: platform backstop over every workspace's ended, priced runs (ids only); each charge is its own run's workspace's */
     SELECT r.id FROM runs r
      WHERE r.price IS NOT NULL AND r.status IN ('succeeded', 'failed', 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM run_charges c WHERE c.run_id = r.id AND c.kind = 'charge')
      ORDER BY r.updated_at LIMIT $1`, [Math.max(1, Math.min(limit, 5000))]));
  let n = 0;
  for (const { id } of ids) {
    try {
      const [r] = await asPlatform(async () => (await getDb()).query<{ id: string | null }>("SELECT octillion_run_charge($1)::text AS id", [id]));
      if (r?.id != null) n++;
    } catch (e) { console.error(`run charges: the charge of ${id} could not be written: ${(e as Error).message}`); }
  }
  return n;
}

// ---------- delivery: to Stripe, or the ledger ----------

/** Back-off after a failed send: 1, 2, 4 ... minutes, at most an hour. */
const backoffSeconds = (attempts: number) => Math.min(3600, 60 * 2 ** Math.max(0, Math.min(attempts - 1, 6)));
/** After this many failed sends a row is no longer tried by itself: it stays pending, with its error, on FinOps. */
export const MAX_DELIVERY_ATTEMPTS = 20;
/**
 * How long after a run ended its charge waits before it is sent (OCTILLION_RUN_CHARGE_GRACE_SECONDS, default 120): a
 * model response still streaming when the run ended is metered when it finishes, and the charge is refreshed with it
 * before it goes. Credits do not wait.
 */
const graceSeconds = () => { const v = Number(process.env.OCTILLION_RUN_CHARGE_GRACE_SECONDS ?? 120); return Number.isFinite(v) && v >= 0 ? Math.min(v, 3600) : 120; };
/** The Stripe identifier of a run's charge, and the idempotency keys: the run's own, so every resend is the same event. */
export const chargeIdentifier = (runId: string) => `run_charge:${runId}`;
export const creditKey = (runId: string) => `run_credit:${runId}`;

export interface DeliveryReport { stripe: number; ledger: number; failed: number; waiting: number; reconciled: number }

const ACTIVE_SUB = new Set(["active", "trialing", "past_due"]);

/**
 * Hand pending charges and credits on: each row is claimed on its own just before it is sent (no other deliverer takes
 * it until its claim lapses, two minutes, far longer than one send), a charge is refreshed with any late model usage,
 * then it goes to Stripe or is settled in the ledger. Where it goes:
 *   no Stripe customer for the workspace                     the ledger
 *   a Stripe customer, but Stripe is not configured here     waits (pending, said why): a missing key must not drop it
 *   the meter (profile billing.stripe_meter) does not exist  waits, said why
 *   the customer has no live subscription priced on it       the ledger, said why (Stripe would never invoice it)
 *   else                                                     one meter event, identifier and idempotency key the run's
 * A credit waits while its charge is on its way, then follows it: a customer balance credit when the charge went to
 * Stripe, else the ledger. `runId` limits it to one run's rows. Never throws for one row's failure.
 */
export async function deliverCharges(opts: { runId?: string; limit?: number } = {}): Promise<DeliveryReport> {
  const out: DeliveryReport = { stripe: 0, ledger: 0, failed: 0, waiting: 0, reconciled: 0 };
  if (opts.runId === undefined) out.reconciled = await reconcileCharges().catch((e) => { console.error("run charges: reconcile failed:", (e as Error).message); return 0; });
  const billing = await import("./billing.js");
  const meterName = billingRules()?.stripe_meter ?? "run_charges";
  const db = await getDb();
  const candidates = await asPlatform(async () => db.query<{ id: string; org_id: number }>(
    `/* tenant: platform delivery, ids only; each row names its own workspace (org_id) */
     SELECT id, org_id FROM run_charges
      WHERE delivery = 'pending' AND (claimed_until IS NULL OR claimed_until < now()) AND delivery_attempts < $3
        AND (kind = 'credit' OR created_at <= now() - make_interval(secs => $4))
        AND ($1::text IS NULL OR run_id = $1) ORDER BY id LIMIT $2`,
    [opts.runId ?? null, Math.max(1, Math.min(opts.limit ?? 100, 1000)), MAX_DELIVERY_ATTEMPTS, graceSeconds()]));
  // Stripe's side, read at most once (fresh when stale) per pass: the meter, and the customers' live subscriptions on it.
  let meterId: string | null | undefined, subs: Awaited<ReturnType<typeof billing.allSubscriptions>>["raw"] | undefined, subsFresh = false;
  const meter = async () => {
    if (meterId !== undefined) return meterId;
    const find = (ms: { id: string; event_name: string; status?: string }[]) => ms.find((m) => m.event_name === meterName && m.status !== "inactive")?.id ?? null;
    meterId = find(await billing.listMeters()) ?? find(await billing.listMeters(true));
    return meterId;
  };
  const onMeter = async (customer: string, mid: string) => {
    const has = (list: typeof subs) => (list ?? []).some((s) => s.customer === customer && ACTIVE_SUB.has(s.status)
      && s.items.data.some((it) => (it.price.recurring as { meter?: string | null } | null | undefined)?.meter === mid));
    subs ??= (await billing.allSubscriptions()).raw;
    if (has(subs) || subsFresh) return has(subs);
    subs = (await billing.allSubscriptions(true)).raw; subsFresh = true;
    return has(subs);
  };
  for (const cand of candidates) {
    // The claim, on this row alone, just before it is sent; a charge first takes in any usage metered since the run ended.
    const [r] = await asPlatform(async () => {
      await db.query(`/* tenant: one pending charge of its own run, refreshed */ SELECT octillion_run_charge_refresh(c.run_id) FROM run_charges c
        WHERE c.id = $1 AND c.org_id = $2 AND c.kind = 'charge' AND c.delivery = 'pending'`, [cand.id, cand.org_id]);
      return db.query<ChargeRow & { stripe_customer_id: string | null }>(
        `UPDATE run_charges c SET claimed_until = now() + interval '2 minutes', delivery_attempts = c.delivery_attempts + 1
          WHERE c.id = $1 AND c.org_id = $2 AND c.delivery = 'pending' AND (c.claimed_until IS NULL OR c.claimed_until < now())
          RETURNING ${COLS.split(",").map((c) => `c.${c.trim()}`).join(", ")},
                    (SELECT o.stripe_customer_id FROM organizations o WHERE o.id = c.org_id) AS stripe_customer_id`, [cand.id, cand.org_id]);
    });
    if (!r) continue; // another deliverer has it
    const settle = (delivery: "stripe" | "ledger", ref: string | null) => asPlatform(async () => db.query(
      `UPDATE run_charges SET delivery = $3, delivery_ref = $4, delivery_error = NULL, delivered_at = now(), claimed_until = NULL
        WHERE id = $1 AND org_id = $2 AND delivery = 'pending'`, [r.id, r.org_id, delivery, ref]));
    /** It stays pending, saying why, and is tried again after its back-off. */
    const wait = (why: string) => asPlatform(async () => db.query(
      `UPDATE run_charges SET delivery_error = $3, claimed_until = now() + make_interval(secs => $4) WHERE id = $1 AND org_id = $2 AND delivery = 'pending'`,
      [r.id, r.org_id, why.slice(0, 500), backoffSeconds(Number(r.delivery_attempts))]));
    try {
      const customer = r.stripe_customer_id;
      if (r.kind === "credit") {
        const [c] = await asPlatform(async () => db.query<{ delivery: string }>(
          "SELECT delivery FROM run_charges WHERE run_id = $1 AND org_id = $2 AND kind = 'charge'", [r.run_id, r.org_id]));
        if (c?.delivery === "pending") {
          // Not an attempt of its own: it goes once its charge has.
          await asPlatform(async () => db.query("UPDATE run_charges SET claimed_until = NULL, delivery_attempts = delivery_attempts - 1 WHERE id = $1 AND org_id = $2 AND delivery = 'pending'", [r.id, r.org_id]));
          out.waiting++; continue;
        }
        if (c?.delivery !== "stripe") { await settle("ledger", null); out.ledger++; continue; }
        if (!billing.stripeEnabled() || !customer) { await wait("Stripe is not configured on this server (STRIPE_SECRET_KEY): the credit waits for it"); out.waiting++; continue; }
        const t = await billing.creditRunCharge(customer, { minor: Number(r.amount_minor), currency: r.currency, runId: r.run_id, key: creditKey(r.run_id),
          description: `Credit for run ${r.run_id}${r.reason ? `: ${r.reason}` : ""}`.slice(0, 350) });
        await settle("stripe", t.id); out.stripe++; continue;
      }
      if (!customer) { await settle("ledger", "the workspace has no Stripe customer"); out.ledger++; continue; }
      if (!billing.stripeEnabled()) { await wait("Stripe is not configured on this server (STRIPE_SECRET_KEY): the charge waits for it"); out.waiting++; continue; }
      const mid = await meter();
      if (!mid) { await wait(`Stripe has no active billing meter named ${meterName}: make one (with a metered price on it) and the charge is sent`); out.waiting++; continue; }
      if (!(await onMeter(customer, mid))) { await settle("ledger", `the customer has no live subscription priced on the meter ${meterName}`); out.ledger++; continue; }
      const identifier = chargeIdentifier(r.run_id);
      await billing.sendRunChargeEvent({ meter: meterName, identifier, customer, value: Number(r.amount_minor) });
      await settle("stripe", identifier); out.stripe++;
    } catch (e) {
      out.failed++;
      const msg = String((e as Error)?.message ?? e).slice(0, 500);
      await wait(Number(r.delivery_attempts) >= MAX_DELIVERY_ATTEMPTS ? `${msg} (gave up after ${MAX_DELIVERY_ATTEMPTS} tries: credit or resend it by hand)` : msg).catch(() => {});
      console.error(`run charges: ${r.kind} for ${r.run_id} not delivered${Number(r.delivery_attempts) >= MAX_DELIVERY_ATTEMPTS ? " (giving up)" : " (retried later)"}: ${msg}`);
      // Given up: a billing notice to the operator, through the email adapter (src/email.ts billingNotice: once per
      // charge, only when the profile turns billing notices on), never in the way of the next row.
      if (Number(r.delivery_attempts) >= MAX_DELIVERY_ATTEMPTS) void billingNoticeFor(r, msg);
    }
  }
  return out;
}

/** The operator's notice for a charge that was given up on: the run, the workspace's slug, the amount; never a customer id. */
async function billingNoticeFor(r: { id: string | number; run_id: string; kind: "charge" | "credit"; org_id: number; amount_minor: string | number; currency: string; delivery_attempts: number }, error: string) {
  try {
    const [o] = await asPlatform(async () => (await getDb()).query<{ slug: string }>("SELECT slug FROM organizations WHERE id = $1", [r.org_id]));
    const exp = exponentOf(r.currency);
    const { billingNotice } = await import("./email.js");
    await billingNotice({ charge_id: String(r.id), run_id: r.run_id, kind: r.kind, account: o?.slug ?? null,
      amount: `${(Number(r.amount_minor) / 10 ** exp).toFixed(exp)} ${r.currency.toUpperCase()}`, tries: Number(r.delivery_attempts), error });
  } catch (e) { console.error(`run charges: the billing notice for ${r.run_id} was not sent: ${(e as Error).message}`); }
}

let timer: NodeJS.Timeout | null = null;
/** The server's loop: pending charges every minute (Vercel has no loop: its cron entry delivers). Only with billing on. */
export function startChargeDelivery(everyMs = 60_000): boolean {
  if (timer || !runBillingOn()) return false;
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    deliverCharges().then((r) => { if (r.stripe || r.failed || r.reconciled) console.error(`run charges: ${r.stripe} to Stripe, ${r.ledger} to the ledger, ${r.failed} failed, ${r.waiting} waiting, ${r.reconciled} reconciled`); })
      .catch((e) => console.error("run charges:", (e as Error).message)).finally(() => { busy = false; });
  };
  timer = setInterval(run, everyMs);
  timer.unref();
  setTimeout(run, 10_000).unref();
  return true;
}
export function stopChargeDelivery() { if (timer) clearInterval(timer); timer = null; }

// ---------- staff credit ----------

export class ChargeError extends Error { constructor(message: string, public status = 400) { super(message); } }

/**
 * Give a run's charge back (platform staff, FinOps › Run charges): one credit of minus the charge, at most once per
 * run, with the reason. Returns the credit; a run with no charge, a charge of 0, or one already credited is refused.
 */
export async function creditRun(runId: string, by: string, reason: unknown): Promise<ChargeView> {
  const why = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
  if (!why) throw new ChargeError("Say why the run is credited (it goes on the credit and the customer's invoice).");
  if (!/^run_[A-Za-z0-9_-]{1,64}$/.test(String(runId))) throw new ChargeError("no such run", 404);
  const [row] = await asPlatform(async () => (await getDb()).query<ChargeRow>(
    `/* tenant: a credit for one run's own charge, written for that charge's workspace */
     INSERT INTO run_charges (run_id, org_id, kind, pack, job_kind, attempt, run_status, requested_by, currency, amount_minor, model_cost_usd, reason, credited_by)
     SELECT c.run_id, c.org_id, 'credit', c.pack, c.job_kind, c.attempt, c.run_status, c.requested_by, c.currency, -c.amount_minor, 0, $2, $3
       FROM run_charges c WHERE c.run_id = $1 AND c.kind = 'charge' AND c.amount_minor > 0
     ON CONFLICT (run_id, kind) DO NOTHING RETURNING ${COLS}`, [String(runId), why, by]));
  if (!row) {
    const rows = await asPlatform(async () => (await getDb()).query<{ kind: string; amount_minor: string }>(
      "/* tenant: one run's own ledger rows, for the refusal's reason */ SELECT kind, amount_minor FROM run_charges WHERE run_id = $1", [String(runId)]));
    if (rows.some((x) => x.kind === "credit")) throw new ChargeError("This run's charge has already been credited.", 409);
    if (rows.some((x) => x.kind === "charge")) throw new ChargeError("This run was not charged: there is nothing to credit.", 409);
    throw new ChargeError("This run has no charge.", 404);
  }
  // Handed on now (a credit does not wait), in the background; the loop and the cron entry retry it.
  const p = deliverCharges({ runId: String(runId) }).catch((e) => console.error(`run charges: credit for ${runId}:`, (e as Error).message));
  void import("./telemetry.js").then((t) => t.keepAlive(p)).catch(() => {});
  return chargeView(row);
}

// ---------- what the pages show ----------

const MONTH = "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";

/**
 * The workspace's Billing page (GET /api/app/billing, run_charges): this month's charges and credits per currency and
 * the latest rows (only `person`'s own runs when given; null or absent: everyone's). Undefined with billing off and no charge ever written, so the page is exactly as before.
 */
export async function workspaceCharges(orgId: number, opts: { person?: string | null } = {}) {
  const rules = billingRules();
  const db = await getDb();
  const [{ any }] = await db.query<{ any: boolean }>("SELECT EXISTS (SELECT 1 FROM run_charges WHERE org_id = $1) AS any", [orgId]);
  if (!rules && !any) return undefined;
  const month = await db.query<{ currency: string; charged: string; credited: string; runs: number; charged_runs: number; pending: number }>(
    `SELECT currency, coalesce(sum(amount_minor) FILTER (WHERE kind = 'charge'), 0)::text AS charged, coalesce(sum(amount_minor) FILTER (WHERE kind = 'credit'), 0)::text AS credited,
            count(*) FILTER (WHERE kind = 'charge')::int AS runs, count(*) FILTER (WHERE kind = 'charge' AND amount_minor > 0)::int AS charged_runs,
            count(*) FILTER (WHERE delivery = 'pending')::int AS pending
       FROM run_charges WHERE org_id = $1 AND created_at >= ${MONTH} GROUP BY currency ORDER BY currency`, [orgId]);
  const recent = await db.query<ChargeRow>(
    `SELECT ${COLS} FROM run_charges WHERE org_id = $1 AND ($2::text IS NULL OR requested_by = $2) ORDER BY created_at DESC, id DESC LIMIT 25`,
    [orgId, opts.person ?? null]);
  const major = (minor: string, c: string) => Number(minor) / 10 ** exponentOf(c);
  return {
    enabled: !!rules, currency: rules?.currency ?? month[0]?.currency ?? "usd",
    month: month.map((m) => ({ currency: m.currency, charged: major(m.charged, m.currency), credited: major(m.credited, m.currency),
      net: major(String(Number(m.charged) + Number(m.credited)), m.currency), runs: m.runs, charged_runs: m.charged_runs, pending: m.pending })),
    recent: recent.map(chargeView),
  };
}

/** One currency's totals over a range. */
interface Totals { currency: string; charged: number; credited: number; net: number; runs: number; charged_runs: number; credits: number; pending: number; failed: number }

/**
 * FinOps (admin): charges and credits in a range (UTC days, src/spend.ts spendRange), per currency, per account and
 * the rows themselves (latest first, at most 500). Undefined with billing off and no charge ever written.
 */
export async function adminCharges(R: { start: Date; end: Date; from: string; to: string }, opts: { account?: string; rows?: boolean } = {}) {
  const rules = billingRules();
  const db = await getDb();
  const [{ any }] = await asPlatform(async () => db.query<{ any: boolean }>("/* tenant: platform report, existence only */ SELECT EXISTS (SELECT 1 FROM run_charges) AS any"));
  if (!rules && !any) return undefined;
  const rows = await asPlatform(async () => db.query<ChargeRow & { slug: string; name: string | null }>(
    `/* tenant: platform report across workspaces (FinOps, platform admins only) */
     SELECT ${COLS.split(",").map((c) => `c.${c.trim()}`).join(", ")}, coalesce(o.slug, 'deleted-' || c.org_id) AS slug, coalesce(o.name, 'Deleted workspace ' || c.org_id) AS name
       FROM run_charges c LEFT JOIN organizations o ON o.id = c.org_id
      WHERE c.created_at >= $1 AND c.created_at < $2 AND ($3::text IS NULL OR o.slug = $3) ORDER BY c.created_at DESC, c.id DESC LIMIT 20000`,
    [R.start, R.end, opts.account ?? null]));
  const totals = new Map<string, Totals>();
  const accounts = new Map<string, Totals & { slug: string; name: string | null }>();
  const add = (t: Totals, r: ChargeRow) => {
    const exp = exponentOf(r.currency), v = Number(r.amount_minor) / 10 ** exp;
    if (r.kind === "charge") { t.charged += v; t.runs++; if (Number(r.amount_minor) > 0) t.charged_runs++; } else { t.credited += v; t.credits++; }
    t.net = t.charged + t.credited;
    if (r.delivery === "pending") { t.pending++; if (r.delivery_error) t.failed++; }
  };
  const blank = (currency: string): Totals => ({ currency, charged: 0, credited: 0, net: 0, runs: 0, charged_runs: 0, credits: 0, pending: 0, failed: 0 });
  for (const r of rows) {
    add(totals.get(r.currency) ?? totals.set(r.currency, blank(r.currency)).get(r.currency)!, r);
    const k = `${r.slug}\u0000${r.currency}`;
    add(accounts.get(k) ?? accounts.set(k, { ...blank(r.currency), slug: r.slug, name: r.name }).get(k)!, r);
  }
  const round = <T extends Totals>(t: T): T => ({ ...t, charged: Math.round(t.charged * 1000) / 1000, credited: Math.round(t.credited * 1000) / 1000, net: Math.round(t.net * 1000) / 1000 });
  return {
    enabled: !!rules, currency: rules?.currency ?? null, meter: rules ? rules.stripe_meter : null,
    rules: rules ? { max_fixed: rules.max_fixed, max_cost_plus_percent: rules.max_cost_plus_percent, charge_failed_runs: rules.charge_failed_runs, charge_cancelled_runs: rules.charge_cancelled_runs } : null,
    range: { from: R.from, to: R.to },
    totals: [...totals.values()].map(round),
    accounts: [...accounts.values()].map(round).sort((a, b) => b.net - a.net),
    ...(opts.rows === false ? {} : { rows: rows.slice(0, 500).map((r) => ({ ...chargeView(r), account: { slug: r.slug, name: r.name } })) }),
  };
}
