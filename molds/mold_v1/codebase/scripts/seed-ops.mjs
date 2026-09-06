// Seed the connectors + workflows tables with the app's default entries so the
// ops-center modals are populated on first load. Idempotent: only inserts when
// the table is empty. Run with DATABASE_URL set.
import { getDb, closeDb } from "../agent/lib/db/index.ts";
import { connectors, workflows } from "../agent/lib/db/schema.ts";

const CONNECTORS = [
  { name: "System of record", kind: "system_of_record", access: "read_write", status: "connected",
    detail: "Neon Postgres — customers, tickets, deployments, interactions",
    lands: "Postgres (Drizzle) · mirrored to Customers/{id}/interactions.jsonl",
    synced: ["customers.json", "people.json", "Workbook sheets"] },
  { name: "Slack", kind: "slack", access: "read_write", status: "connected",
    detail: "Customer channels & alerts via Vercel Connect",
    lands: "Customers/·/Tickets/·/People/syncs/slack",
    synced: ["#acme-support", "#northwind-onboarding", "Customer DMs", "Alerts"] },
  { name: "GitHub", kind: "github", access: "read", status: "read_only",
    detail: "Releases, commits, PRs (read-only PAT)",
    lands: "Platform/·/Deployments/syncs/github",
    synced: ["Releases", "Commits", "Pull requests", "Tags"] },
  { name: "Granola", kind: "granola", access: "read", status: "connected",
    detail: "Meeting notes, attendees, action items",
    lands: "Customers/·/People/syncs/meeting_notes/granola",
    synced: ["Meeting notes", "Attendees", "Action items"] },
  { name: "Gmail", kind: "gmail", access: "read_write", status: "connected",
    detail: "IMAP threads & drafts (draft-only, never sends)",
    lands: "Customers/·/Tickets/·/People/syncs/email",
    synced: ["Email threads", "Follow-up drafts", "Attachments"] },
  { name: "Vercel", kind: "vercel", access: "read", status: "connected",
    detail: "Deployments, build logs, runtime metrics",
    lands: "Deployments/syncs",
    synced: ["Deployments", "Build logs", "Runtime metrics", "Regions"] },
];

const WORKFLOWS = [
  { name: "deployment", description: "Deploy & operate customer platforms; owns the 4-party infra signoff chain.", trigger: "on delegation" },
  { name: "configuration", description: "Configure models, connections, feature flags, guardrails.", trigger: "on delegation" },
  { name: "evals", description: "Build, run & interpret eval suites; catch regressions.", trigger: "on delegation" },
  { name: "data-migration", description: "Plan & execute customer data migrations and backfills.", trigger: "on delegation" },
  { name: "customer-context", description: "Keep the system of record current from meetings, email, Slack.", trigger: "on delegation" },
  { name: "follow-ups", description: "Chase open follow-ups; prepare the daily stand-up summary.", trigger: "on delegation" },
  { name: "research", description: "Research an account & build its 7 domain workbooks.", trigger: "on delegation" },
];

const db = getDb();
if (!db) {
  console.error("seed-ops: no DATABASE_URL — nothing seeded");
  process.exit(1);
}

const existingC = await db.select({ id: connectors.id }).from(connectors).limit(1);
if (existingC.length === 0) {
  await db.insert(connectors).values(CONNECTORS.map((c) => ({ ...c, createdBy: "seed" })));
  console.log(`seed-ops: inserted ${CONNECTORS.length} connectors`);
} else {
  console.log("seed-ops: connectors already populated, skipping");
}

const existingW = await db.select({ id: workflows.id }).from(workflows).limit(1);
if (existingW.length === 0) {
  await db.insert(workflows).values(WORKFLOWS.map((w) => ({ ...w, createdBy: "seed" })));
  console.log(`seed-ops: inserted ${WORKFLOWS.length} workflows`);
} else {
  console.log("seed-ops: workflows already populated, skipping");
}

await closeDb();
console.log("seed-ops: done");
