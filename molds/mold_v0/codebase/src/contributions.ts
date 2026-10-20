/**
 * Library contributions: an account publishes one of its OWN developer personas or programming tasks to Octillion's
 * shared library, and earns a credit on its next invoice when Octillion accepts it.
 *
 *   customer (/app personas and tasks pages, MCP publish_to_library; Member role or above)
 *     publish   -> a library_submissions row, status 'submitted', with a sealed snapshot of the content as it is now
 *                  (no account name). One open request per item; a decided item can be submitted again once edited.
 *     withdraw  -> 'withdrawn', while still 'submitted'
 *   Octillion (/admin/personas and /admin/tasks, Submissions; the `library` admin permission)
 *     accept    -> the snapshot becomes a new shared library row (source 'contributed', contributed_by, submission_id),
 *                  active, editable like any library row; then a Stripe customer-balance credit (below)
 *     decline   -> 'declined' with a reason the account sees
 *
 * The money lives in Stripe (src/billing.ts): accepting credits the account's Stripe customer balance with a negative
 * balance transaction (description "Library contribution: <title>", metadata library_submission_id), which Stripe
 * applies to the next invoice. credit_status only tracks whether that has been done: 'pending' until Stripe answers
 * (no Stripe customer yet, or Stripe failing: the accept still stands and Retry credit tries again), 'credited' with the
 * transaction id, 'none' for a zero credit. Never twice: the idempotency key is the submission id, a retry first looks
 * for a transaction with that metadata, and only a 'pending' row is ever credited.
 *
 * Octillion's library stays locked away from customers (they never list it): nothing here returns a library row, its
 * slug or id to the account. The account's own copy stays theirs, unchanged.
 */
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import type { Org } from "./auth.js";
import { ensureOrgKey, open as openText, openJson, sealJson } from "./orgcrypto.js";
import { freshSettings, settingNumber } from "./settings.js";
import * as billing from "./billing.js";
import { AdminError, log } from "./admin.js";
import { platformOf } from "./platform.js";
import * as mail from "./email.js";
import { SCENARIO_ROWS } from "./queries.js";

export type Kind = "persona" | "task";
export type SubmissionStatus = "submitted" | "accepted" | "declined" | "withdrawn";

const rid = () => `lsub_${randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
const NOUN: Record<Kind, string> = { persona: "persona", task: "task" };
/** JSON with sorted keys, so two snapshots compare equal whatever order Postgres kept their keys in. */
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null);

/** The credit an accepted item earns, from Agent configuration (src/settings.ts). */
export async function discountUsd(): Promise<Record<Kind, number>> {
  await freshSettings();
  return { persona: settingNumber("PUBLISH_DISCOUNT_PERSONA_USD"), task: settingNumber("PUBLISH_DISCOUNT_TASK_USD") };
}

/** What a submission looks like to the account: its state, the decline reason, the credit; never the library row. */
export interface Publication {
  id: string; status: Exclude<SubmissionStatus, "withdrawn">; reason: string | null; submitted_at: string; decided_at: string | null; credit_usd: number | null;
}

/**
 * Each item's publication state for one account: its latest request that was not withdrawn (an item never published,
 * or whose only requests were withdrawn, has none).
 */
export async function publicationsFor(orgId: number, kind: Kind): Promise<Map<string, Publication>> {
  const rows = await (await getDb()).query<any>(
    `SELECT DISTINCT ON (source_ref) id, source_ref, status, reason, created_at, decided_at, credit_usd
       FROM library_submissions WHERE org_id = $1 AND kind = $2 AND status <> 'withdrawn' ORDER BY source_ref, created_at DESC`, [orgId, kind]);
  return new Map(rows.map((r) => [String(r.source_ref), {
    id: r.id, status: r.status, reason: r.status === "declined" ? r.reason : null, submitted_at: new Date(r.created_at).toISOString(),
    decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null, credit_usd: r.status === "accepted" && r.credit_usd != null ? Number(r.credit_usd) : null,
  }]));
}

// ---------- what gets shared ----------

interface PersonaSnapshot { name: string; summary: string; instructions: string; attributes: Record<string, unknown>; environment: unknown }
interface TaskSnapshot { title: string; prompt: string; repo_url: string | null; language: string | null; tags: string[]; platform: string | null; template: string | null }

/** The account's own persona or task, as it would be shared (no account name, no provenance), and its title. */
async function snapshotOf(org: Org, kind: Kind, ref: string): Promise<{ title: string; snapshot: PersonaSnapshot | TaskSnapshot }> {
  const db = await getDb();
  if (kind === "persona") {
    const [p] = await db.query<any>(
      "SELECT slug, name, summary, instructions, attributes, environment, source FROM developer_profiles WHERE slug = $1 AND org_id = $2", [ref, org.orgId]);
    if (!p) throw new Error(`No persona ${ref}. See list_personas.`);
    if (p.source !== "custom") throw new Error("Only personas your account wrote can be published. This one was picked or written for your product by onboarding.");
    return { title: p.name, snapshot: {
      name: p.name, summary: await openText(org.orgId, p.summary ?? ""), instructions: await openText(org.orgId, p.instructions ?? ""),
      attributes: await openJson(org.orgId, p.attributes), environment: p.environment ?? null,
    } };
  }
  const id = Number(ref);
  const [t] = Number.isInteger(id) ? await db.query<any>(
    `SELECT sc.id, sc.title, sc.prompt, sc.repo_url, sc.language, sc.tags, sc.platform, sc.template, sc.source, sc.library_task_id, ts.id AS set_id
       FROM ${SCENARIO_ROWS} sc JOIN products p ON p.id = sc.product_id AND p.org_id = $1
       LEFT JOIN org_task_sets ts ON ts.id = sc.task_set_id AND ts.org_id = $1 WHERE sc.id = $2`, [org.orgId, id]) : [];
  if (!t || (!t.set_id && t.library_task_id == null)) throw new Error(`No task ${ref}. See list_task_sets.`);
  if (!t.set_id || t.library_task_id != null || t.source !== "custom")
    throw new Error("Only tasks from your own task sets can be published. This one was picked for your product by onboarding.");
  return { title: t.title, snapshot: {
    title: t.title, prompt: await openText(org.orgId, t.prompt), repo_url: t.repo_url ?? null, language: t.language ?? null,
    tags: t.tags ?? [], platform: t.platform ?? null, template: t.template ?? null,
  } };
}

/** Publish one of the account's own personas (slug) or tasks (id) to Octillion's library: a request Octillion reviews. */
export async function publish(org: Org, actor: string, kind: Kind, ref: string) {
  if (kind !== "persona" && kind !== "task") throw new Error("kind must be persona or task");
  const { title, snapshot } = await snapshotOf(org, kind, String(ref));
  const db = await getDb();
  const prior = await db.query<any>(
    `SELECT id, status, snapshot FROM library_submissions WHERE org_id = $1 AND kind = $2 AND source_ref = $3 AND status <> 'withdrawn'
      ORDER BY created_at DESC LIMIT 1`, [org.orgId, kind, String(ref)]);
  const last = prior[0];
  if (last?.status === "submitted") throw new Error(`This ${NOUN[kind]} is already submitted. Octillion will review it; you can withdraw it until then.`);
  if (last && stable(await openJson(org.orgId, last.snapshot)) === stable(snapshot))
    throw new Error(`This ${NOUN[kind]} was already ${last.status === "accepted" ? "accepted" : "reviewed"} as it is now. Edit it first to submit it again.`);
  await ensureOrgKey(org.orgId);
  const id = rid();
  try {
    await db.query(
      `INSERT INTO library_submissions (id, org_id, kind, source_ref, title, snapshot, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'submitted', $7)`,
      [id, org.orgId, kind, String(ref), title, JSON.stringify(await sealJson(org.orgId, snapshot as unknown as Record<string, unknown>)), actor]);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new Error(`This ${NOUN[kind]} is already submitted. Octillion will review it; you can withdraw it until then.`);
    throw e;
  }
  const credit = (await discountUsd())[kind];
  mail.fire(mail.submissionReceived({ id, kind, title, org_id: org.orgId, org_name: org.name, org_slug: org.slug, created_by: actor }));
  return { view: "library_submission" as const, submission: (await publicationsFor(org.orgId, kind)).get(String(ref))!, kind, ref: String(ref), title, credit_usd: credit };
}

/** Withdraw a request that is still waiting for review. */
export async function withdraw(org: Org, id: string) {
  const [row] = await (await getDb()).query<{ id: string; kind: Kind; source_ref: string }>(
    "UPDATE library_submissions SET status = 'withdrawn', updated_at = now() WHERE id = $1 AND org_id = $2 AND status = 'submitted' RETURNING id, kind, source_ref",
    [id, org.orgId]);
  if (!row) throw new Error(`No open submission ${id}`);
  return { withdrawn: row.id, kind: row.kind, ref: row.source_ref };
}

/** Billing page: the contribution credits Stripe holds for the account, and accepted ones Stripe has not taken yet. */
export async function creditsFor(orgId: number) {
  const db = await getDb();
  const [o] = await db.query<{ stripe_customer_id: string | null }>("SELECT stripe_customer_id FROM organizations WHERE id = $1", [orgId]);
  const pending = await db.query<any>(
    "SELECT id, kind, title, credit_usd, decided_at FROM library_submissions WHERE org_id = $1 AND status = 'accepted' AND credit_status = 'pending' ORDER BY decided_at DESC", [orgId]);
  let credits: { id: string; amount_usd: number; currency: string; description: string | null; created: string; submission_id: string }[] = [];
  let error: string | null = null;
  if (o?.stripe_customer_id && billing.stripeEnabled()) {
    try {
      credits = (await billing.contributionCredits(o.stripe_customer_id)).map((t) => ({
        id: t.id, amount_usd: -t.amount / 100, currency: t.currency, description: t.description, created: new Date(t.created * 1000).toISOString(),
        submission_id: t.metadata![billing.CONTRIBUTION_META]!,
      }));
    } catch (e) { error = (e as Error).message; }
  }
  return {
    credits, error, total_usd: Math.round(credits.reduce((s, c) => s + c.amount_usd, 0) * 100) / 100,
    pending: pending.map((p) => ({ id: p.id, kind: p.kind, title: p.title, credit_usd: Number(p.credit_usd), decided_at: p.decided_at })),
  };
}

// ---------- Octillion's review (/admin/personas and /admin/tasks, Submissions) ----------

const ADMIN_COLS = `s.id, s.org_id, s.kind, s.source_ref, s.title, s.snapshot, s.status, s.decided_by, s.decided_at, s.reason, s.library_ref, s.credit_usd,
  s.credit_status, s.credit_error, s.stripe_txn_id, s.created_by, s.created_at, s.updated_at, o.name AS org_name, o.slug AS org_slug,
  (o.stripe_customer_id IS NOT NULL) AS has_stripe_customer`;

async function shapeAdmin(r: any) {
  const { snapshot, ...rest } = r;
  return { ...rest, credit_usd: r.credit_usd == null ? null : Number(r.credit_usd), content: await openJson(r.org_id, snapshot) };
}

/** Submissions of one kind (?status: submitted, accepted, declined, withdrawn; default every one), newest first. */
export async function listSubmissions(q: Record<string, unknown>) {
  const kind = q.kind === "task" ? "task" : "persona";
  const status = ["submitted", "accepted", "declined", "withdrawn"].includes(String(q.status)) ? String(q.status) : null;
  const db = await getDb();
  const rows = await db.query<any>(
    `/* tenant: admin-only: Octillion reviews every account's submissions */ SELECT ${ADMIN_COLS}
       FROM library_submissions s JOIN organizations o ON o.id = s.org_id
      WHERE s.kind = $1 ${status ? "AND s.status = $2" : ""} ORDER BY s.created_at DESC LIMIT 1000`, status ? [kind, status] : [kind]);
  const counts = await db.query<{ status: string; n: number }>(
    "/* tenant: admin-only */ SELECT status, count(*) AS n FROM library_submissions WHERE kind = $1 GROUP BY status", [kind]);
  return {
    kind, submissions: await Promise.all(rows.map(shapeAdmin)), default_credit_usd: (await discountUsd())[kind as Kind],
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) as Record<string, number>, stripe: billing.stripeEnabled(),
  };
}

async function submission(id: string) {
  const [r] = await (await getDb()).query<any>(
    `/* tenant: admin-only */ SELECT ${ADMIN_COLS} FROM library_submissions s JOIN organizations o ON o.id = s.org_id WHERE s.id = $1`, [id]);
  if (!r) throw new AdminError(`No submission ${id}`, 404);
  return r;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Accept: copy the submitted content into the shared library as a new row (source 'contributed'), then credit the
 * account in Stripe. `credit_usd` overrides the amount from settings (0 for none). The accept stands even when the
 * credit can't be made yet (credit_status 'pending', Retry credit).
 */
export async function accept(actor: string, id: string, body: Record<string, unknown> = {}) {
  const cur = await submission(id);
  const kind = cur.kind as Kind;
  let credit = (await discountUsd())[kind];
  if (body.credit_usd !== undefined && body.credit_usd !== null && body.credit_usd !== "") {
    credit = Number(body.credit_usd);
    if (!Number.isFinite(credit) || credit < 0 || credit > 1000) throw new AdminError("The credit must be between $0 and $1,000");
  }
  credit = Math.round(credit * 100) / 100;
  const db = await getDb();
  let libraryRef = "";
  await db.transaction(async (tx) => {
    const [claimed] = await tx.query<any>(
      "/* tenant: admin-only */ UPDATE library_submissions SET status = 'accepted', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1 AND status = 'submitted' RETURNING org_id, snapshot",
      [id, actor]);
    if (!claimed) throw new AdminError(`This submission is ${cur.status}, not waiting for review`, 409);
    const c = await openJson(claimed.org_id, claimed.snapshot) as any;
    const suffix = randomBytes(3).toString("hex");
    if (kind === "persona") {
      libraryRef = `contrib-${slugify(String(c.name ?? "persona"))}-${suffix}`;
      await tx.query(
        `INSERT INTO developer_profiles (slug, name, summary, attributes, instructions, environment, source, active, edited_at, edited_by, contributed_by, submission_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'contributed', true, now(), $7, $8, $9)`,
        [libraryRef, String(c.name ?? "").slice(0, 120) || cur.title, c.summary ?? "", JSON.stringify(c.attributes ?? {}), c.instructions ?? "",
         c.environment ? JSON.stringify(c.environment) : null, actor, claimed.org_id, id]);
    } else {
      const platform = c.platform ?? platformOf({ template: c.template ?? undefined, language: c.language, tags: c.tags ?? [], prompt: c.prompt });
      const [row] = await tx.query<{ id: number }>(
        `INSERT INTO library_tasks (slug, title, prompt, repo_url, language, category, tags, attributes, platform, source, active, edited_at, edited_by, contributed_by, submission_id)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, 'contributed', true, now(), $9, $10, $11) RETURNING id`,
        [`contrib-${slugify(String(c.title ?? "task"))}-${suffix}`, String(c.title ?? cur.title).slice(0, 200), c.prompt, c.repo_url ?? null, c.language ?? null,
         c.tags ?? [], JSON.stringify(c.template ? { template: c.template } : {}), platform, actor, claimed.org_id, id]);
      libraryRef = String(row!.id);
    }
    await tx.query(
      "/* tenant: admin-only */ UPDATE library_submissions SET library_ref = $2, credit_usd = $3, credit_status = $4 WHERE id = $1",
      [id, libraryRef, credit, credit > 0 ? "pending" : "none"]);
  });
  log(actor, "library.submission.accept", cur.org_slug, { submission: id, kind, library_ref: libraryRef, credit_usd: credit });
  await creditNow(id);
  const after = await submission(id);
  // To the person who submitted it, with the credit as it stands now (credited, or still pending).
  mail.fire(mail.submissionAccepted(factsOf(after), { usd: Number(after.credit_usd ?? 0), status: after.credit_status }));
  return shapeAdmin(after);
}

const factsOf = (r: any): mail.SubmissionFacts => ({ id: r.id, kind: r.kind, title: r.title, org_id: r.org_id, org_name: r.org_name, org_slug: r.org_slug, created_by: r.created_by });

/** Decline, with the reason the account sees. */
export async function decline(actor: string, id: string, reason: unknown) {
  const why = str(reason, 500);
  if (!why) throw new AdminError("Say why it is declined: the account sees the reason");
  const cur = await submission(id);
  const [row] = await (await getDb()).query(
    "/* tenant: admin-only */ UPDATE library_submissions SET status = 'declined', reason = $2, decided_by = $3, decided_at = now(), updated_at = now() WHERE id = $1 AND status = 'submitted' RETURNING id",
    [id, why, actor]);
  if (!row) throw new AdminError(`This submission is ${cur.status}, not waiting for review`, 409);
  log(actor, "library.submission.decline", cur.org_slug, { submission: id, kind: cur.kind });
  mail.fire(mail.submissionDeclined(factsOf(cur), why));
  return shapeAdmin(await submission(id));
}

/** Retry credit on an accepted submission whose credit is still pending. */
export async function retryCredit(actor: string, id: string) {
  const cur = await submission(id);
  if (cur.status !== "accepted" || cur.credit_status !== "pending") throw new AdminError("Nothing to retry: the credit is not pending", 409);
  await creditNow(id);
  const after = await submission(id);
  log(actor, "library.submission.credit_retry", cur.org_slug, { submission: id, credited: after.credit_status === "credited" });
  return shapeAdmin(after);
}

/**
 * Make a pending credit in Stripe. First looks for a balance transaction already carrying this submission id (a credit
 * whose answer was lost), then creates one with the submission id as idempotency key. A failure leaves it pending, with
 * the reason in credit_error.
 */
async function creditNow(id: string) {
  const db = await getDb();
  const r = await submission(id);
  if (r.status !== "accepted" || r.credit_status !== "pending") return;
  const fail = (msg: string) => db.query("/* tenant: admin-only */ UPDATE library_submissions SET credit_error = $2, updated_at = now() WHERE id = $1", [id, msg.slice(0, 500)]);
  if (!billing.stripeEnabled()) return void (await fail("Stripe is not configured (STRIPE_SECRET_KEY)"));
  const [o] = await db.query<{ stripe_customer_id: string | null }>("SELECT stripe_customer_id FROM organizations WHERE id = $1", [r.org_id]);
  if (!o?.stripe_customer_id) return void (await fail("The account has no Stripe customer yet. It gets one when it chooses a plan; then Retry credit."));
  try {
    const existing = (await billing.contributionCredits(o.stripe_customer_id)).find((t) => t.metadata?.[billing.CONTRIBUTION_META] === id);
    const txn = existing ?? await billing.creditCustomerBalance(o.stripe_customer_id, {
      cents: Math.round(Number(r.credit_usd) * 100), description: `Library contribution: ${String(r.title).slice(0, 200)}`, submissionId: id, kind: r.kind });
    await db.query(
      "/* tenant: admin-only */ UPDATE library_submissions SET credit_status = 'credited', stripe_txn_id = $2, credit_error = NULL, updated_at = now() WHERE id = $1 AND credit_status = 'pending'",
      [id, txn.id]);
  } catch (e) {
    console.error(`library credit ${id} failed:`, (e as Error).message);
    await fail((e as Error).message);
  }
}
