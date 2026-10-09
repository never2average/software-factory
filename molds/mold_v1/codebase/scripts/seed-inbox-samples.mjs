/**
 * Seed sample conversations into the Inbox so the UI can be judged with real
 * content instead of an empty state.
 *
 * PASTE YOUR OWN into SAMPLES below — one object per message. Messages sharing
 * a `threadKey` become one conversation, which is the thing worth exercising:
 * a single-message note and a nine-message argument should both look right.
 *
 * Idempotent: re-running updates rather than duplicates, matching the unique
 * key ingestion will use (org_id, source, external_id).
 *
 * Run:  ! node scripts/seed-inbox-samples.mjs
 *       ! node scripts/seed-inbox-samples.mjs --clear   (remove samples only)
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { W } from "../lib/ui-words.ts";

/* ─── Paste here ─────────────────────────────────────────────────────────────
 * source:     "email" | "granola" | "slack"   (drives the row icon)
 * threadKey:  messages sharing one become a single conversation
 * customerId: null to test the "unmatched" path — leave some unmatched
 * ─────────────────────────────────────────────────────────────────────────── */
const SAMPLES = [
  // A back-and-forth: the case grouping exists for.
  {
    source: "email", threadKey: "thr-renewal-q3", customerId: "acme-bank",
    subject: "Re: Q3 renewal — seat count and the SSO blocker",
    participants: ["dana@acmebank.com"],
    occurredAt: "2026-08-04T09:12:00Z",
    body: "Hi — before we can sign off on the renewal we need two things settled:\n\n1. Seat count. We're at 240 provisioned but only ~180 active. Can we true down at renewal?\n2. SSO. The Okta integration still drops group claims on re-auth, which means our analysts land without the right role about once a week.\n\nThe second one is the blocker for us.",
  },
  {
    source: "email", threadKey: "thr-renewal-q3", customerId: "acme-bank",
    subject: "Re: Q3 renewal — seat count and the SSO blocker",
    participants: ["quinn@example.com"],
    occurredAt: "2026-08-04T11:40:00Z",
    body: "Thanks Dana. Truing down to 180 is fine — I'll get a revised order form over today.\n\nOn SSO: the dropped group claim is a known issue on re-auth when the IdP omits the groups scope. We shipped a fix last Thursday. Can you confirm which build you're on?",
  },
  {
    source: "email", threadKey: "thr-renewal-q3", customerId: "acme-bank",
    subject: "Re: Q3 renewal — seat count and the SSO blocker",
    participants: ["sam@acmebank.com", "dana@acmebank.com"],
    occurredAt: "2026-08-05T08:05:00Z",
    body: "Sam here (platform). We're on 4.2.1, deployed 22 July — so before your fix. We can take the upgrade in next Tuesday's window if you confirm it's the same root cause.",
  },

  // Unmatched sender: the state the Customer column exists to surface.
  {
    source: "email", threadKey: "thr-northwind-intro", customerId: null,
    subject: "Intro — Northwind Capital, evaluating for Q4",
    participants: ["priya@northwind.com"],
    occurredAt: "2026-08-05T16:22:00Z",
    body: "Hello — we were referred by a portfolio company. We're a 40-person credit fund looking at data-room automation for our diligence workflow. Is there a technical call we could book for next week?",
  },

  // A meeting note: one long single-message thread.
  {
    source: "granola", threadKey: "gran-acme-qbr-aug", customerId: "acme-bank",
    subject: "Acme Bank — August QBR",
    participants: ["dana@acmebank.com", "sam@acmebank.com", "quinn@example.com"],
    occurredAt: "2026-08-03T14:00:00Z",
    body: "Attendees: Dana (VP Ops), Sam (Platform), Quinn\n\nHealth: green on usage, amber on sentiment — the SSO issue has come up in all three of the last calls.\n\nValue realised: 11 hours/week saved across the diligence team, against a target of 15. Dana wants the gap closed before renewal so she can defend the spend internally.\n\nExpansion: interested in the workflow builder for their credit committee prep. Not budgeted this year; revisit in Q1.\n\nActions:\n- Ship the SSO group-claim fix (us, this week)\n- Revised order form at 180 seats (us, today)\n- Dana to confirm the Tuesday upgrade window",
  },

  // Slack: short, informal, and the one most likely to be dismissed.
  {
    source: "slack", threadKey: "slack-C04-1754", customerId: "acme-bank",
    subject: "#acme-shared — deploy window",
    participants: ["sam@acmebank.com"],
    occurredAt: "2026-08-05T10:15:00Z",
    body: "heads up — we're freezing changes 12–14 Aug for our own audit. anything you need to land, land it before then",
  },
];

/* ─────────────────────────────────────────────────────────────────────────── */

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const sql = postgres(env.DATABASE_URL, { ssl: "require", prepare: false, connect_timeout: 20 });

const [org] = await sql`SELECT org_id FROM orgs ORDER BY created_at LIMIT 1`;
if (!org) {
  console.error("✗ No workspace exists yet — onboard one first.");
  process.exit(1);
}
const orgId = org.org_id;
console.log(`workspace ${orgId}\n`);

if (process.argv.includes("--clear")) {
  const gone = await sql`DELETE FROM inbox_items WHERE org_id = ${orgId} AND external_id LIKE 'sample-%' RETURNING id`;
  console.log(`removed ${gone.length} sample item(s)`);

  /**
   * Also remove the customers this seeder invented — but only when they are
   * still untouched.
   *
   * A customer is left alone if anything real now hangs off it (an interaction,
   * a ticket, a deployment) or if someone has given it a company domain, which
   * a seeded row never has. Deleting a customer that has since become real, on
   * the strength of it sharing an id with a sample, is the kind of cleanup that
   * destroys work.
   */
  for (const id of [...new Set(SAMPLES.map((x) => x.customerId).filter(Boolean))]) {
    const [c] = await sql`SELECT company_domain FROM customers WHERE customer_id = ${id} AND org_id = ${orgId}`;
    if (!c) continue;
    if (c.company_domain) {
      console.log(`  kept ${id} — it has a company domain, so it is no longer a sample`);
      continue;
    }
    const [{ refs }] = await sql`
      SELECT (
        (SELECT count(*) FROM interactions   WHERE customer_id = ${id} AND org_id = ${orgId}) +
        (SELECT count(*) FROM tickets        WHERE customer_id = ${id} AND org_id = ${orgId}) +
        (SELECT count(*) FROM deployments    WHERE customer_id = ${id} AND org_id = ${orgId}) +
        (SELECT count(*) FROM implementation WHERE customer_id = ${id} AND org_id = ${orgId}) +
        (SELECT count(*) FROM solutions      WHERE customer_id = ${id} AND org_id = ${orgId})
      )::int AS refs`;
    if (refs > 0) {
      console.log(`  kept ${id} — ${refs} record(s) now reference it`);
      continue;
    }
    await sql`DELETE FROM customers WHERE customer_id = ${id} AND org_id = ${orgId}`;
    console.log(`  removed ${W.account} ${id}`);
  }

  const [{ n }] = await sql`SELECT count(*)::int AS n FROM inbox_items WHERE org_id = ${orgId}`;
  console.log(`\ninbox_items remaining: ${n}`);
  await sql.end();
  process.exit(0);
}

// Promotion requires a customer that exists IN THIS WORKSPACE, so the matched
// samples need one to point at. Created only if absent — never overwriting a
// real account that happens to share the id.
const referenced = [...new Set(SAMPLES.map((s) => s.customerId).filter(Boolean))];
for (const id of referenced) {
  const [exists] = await sql`SELECT 1 AS x FROM customers WHERE customer_id = ${id} AND org_id = ${orgId}`;
  if (!exists) {
    await sql`INSERT INTO customers (customer_id, org_id, customer_name)
              VALUES (${id}, ${orgId}, ${id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())})`;
    console.log(`  + ${W.account} ${id}`);
  }
}

let n = 0;
for (const [i, s] of SAMPLES.entries()) {
  const externalId = `sample-${s.threadKey}-${i}`;
  await sql`
    INSERT INTO inbox_items
      (org_id, source, external_id, thread_key, subject, preview, body, participants, occurred_at, customer_id, status)
    VALUES (
      ${orgId}, ${s.source}, ${externalId}, ${s.threadKey}, ${s.subject},
      ${s.body.split("\n")[0].slice(0, 140)}, ${s.body},
      ${sql.json(s.participants)}, ${s.occurredAt}, ${s.customerId ?? null}, 'new'
    )
    ON CONFLICT (org_id, source, external_id) DO UPDATE SET
      thread_key = EXCLUDED.thread_key, subject = EXCLUDED.subject,
      preview = EXCLUDED.preview, body = EXCLUDED.body,
      participants = EXCLUDED.participants, occurred_at = EXCLUDED.occurred_at,
      customer_id = EXCLUDED.customer_id`;
  n++;
}

const threads = new Set(SAMPLES.map((s) => s.threadKey)).size;
console.log(`\n✓ ${n} message(s) across ${threads} conversation(s)`);
console.log("  Open the Ops Center → Inbox. Re-run after editing SAMPLES; it updates in place.");
await sql.end();
