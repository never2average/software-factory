/**
 * Fallback-path test for the system of record (agent/lib/system-of-record.ts).
 *
 * Runs with NO database URL, asserting the bundled-JSON in-memory fallback
 * behaves exactly like the pre-Postgres store: get_customer/list_customers/
 * list_followups return the seed data verbatim, and upsert/record/resolve
 * mutate the in-memory copy. No Postgres connection is ever attempted.
 *
 * Usage: npm run test:sor
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Force the fallback path and isolate every disk write: no DB URL, a scratch
// cwd, and a scratch data-room root. (The store no longer persists to disk at
// all; the scratch cwd stays as a belt for anything else that writes.)
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

// Seed the in-memory store. These assertions target a customer that used to
// live in data/customers.json until c7b929c emptied it; the fixture now
// belongs to the tests, not to shipped product data.
const { seedFixtureStore } = await import("./lib/test-fixture.mjs");
const seededIds = await seedFixtureStore();
const scratch = mkdtempSync(path.join(tmpdir(), "sor-test-"));
process.env.DATAROOM_DIR = path.join(scratch, "dataroom");
process.chdir(scratch);

const { customerStoreSchema } = await import("../agent/lib/customer-schema.ts");
const sor = await import("../agent/lib/system-of-record.ts");
const { getDb } = await import("../agent/lib/db/index.ts");

assert.equal(getDb(), null, "no DB URL is set, getDb() must return null (fallback path)");

// The reference copy: the same FIXTURE the store was seeded from, parsed
// through the same Zod contract. It used to read data/customers.json — the
// shipped file — which c7b929c correctly emptied of dummy customers, leaving
// this comparing the store against nothing.
const seedUrl = new URL("./fixtures/customers.fixture.json", import.meta.url);
const reference = customerStoreSchema.parse(JSON.parse(readFileSync(seedUrl, "utf8")));
const referenceById = new Map(reference.customers.map((c) => [c.id, c]));
assert.ok(referenceById.has("acme-bank") && referenceById.has("northwind-cap"));

const OPEN = (t) => !["Resolved", "Closed", "Won't Fix"].includes(t.ticketStatus);

// --- Reads are identical to the seed (non-regression) ----------------------

for (const id of ["acme-bank", "northwind-cap"]) {
  const customer = await sor.getCustomer(id);
  assert.deepEqual(customer, referenceById.get(id), `getCustomer(${id}) must equal the seed record`);
}
assert.equal(await sor.getCustomer("no-such-customer"), null);

assert.deepEqual(
  await sor.listCustomers(),
  // Mirrors listCustomers' Pick<> exactly. It gained companyDomain and the two
  // owner emails after this test was written, and since nothing ran the test
  // the drift went unnoticed — the projection is part of the contract, so the
  // expectation is widened to match rather than loosened to ignore it.
  reference.customers.map((c) => ({
    id: c.id,
    name: c.name,
    tier: c.tier,
    lifecycleStage: c.lifecycleStage,
    status: c.status,
    fdeOwner: c.fdeOwner,
    companyDomain: c.companyDomain,
    businessOwnerEmail: c.businessOwnerEmail,
    technicalOwnerEmail: c.technicalOwnerEmail,
    openTickets: (c.tickets ?? []).filter(OPEN).length,
  })),
);

assert.deepEqual(
  await sor.listFollowUps(),
  reference.customers.flatMap((c) =>
    (c.tickets ?? []).filter(OPEN).map((t) => ({ ...t, customerId: c.id, customerName: c.name })),
  ),
);
const scopedFollowUps = await sor.listFollowUps("acme-bank");
assert.ok(scopedFollowUps.length > 0);
assert.ok(scopedFollowUps.every((f) => f.customerId === "acme-bank" && OPEN(f)));

// --- upsert_customer: merge patch onto an existing record ------------------

const beforeUpsert = await sor.getCustomer("acme-bank");
const upserted = await sor.upsertCustomer({ id: "acme-bank", status: "At Risk" });
assert.equal(upserted.status, "At Risk");
assert.deepEqual(
  { ...upserted, status: beforeUpsert.status },
  beforeUpsert,
  "upsert must only change the patched fields",
);
assert.equal((await sor.getCustomer("acme-bank")).status, "At Risk");

// --- upsert_customer: create a new record ----------------------------------

const created = await sor.upsertCustomer({ id: "new-co", tier: "Pilot" });
assert.equal(created.name, "new-co", "a created customer defaults name to its id");
assert.equal(created.tier, "Pilot");
assert.equal((await sor.getCustomer("new-co")).id, "new-co");
assert.equal((await sor.listCustomers()).length, reference.customers.length + 1);

// --- record_interaction: prepends and mirrors to the data room -------------

const interaction = {
  interactionId: "INT-test-0001",
  interactionAt: "2026-07-10T09:00:00Z",
  interactionType: "note",
  sourceSystem: "manual",
  note: "Fallback-path test interaction.",
};
const afterRecord = await sor.recordInteraction("acme-bank", interaction);
assert.deepEqual(afterRecord.interactions[0], interaction, "new interaction must be first");
assert.equal(
  afterRecord.interactions.length,
  (referenceById.get("acme-bank").interactions ?? []).length + 1,
);
await assert.rejects(
  () => sor.recordInteraction("no-such-customer", interaction),
  /Unknown customer: no-such-customer/,
);

// Document-view mirror: Customers/{id}/interactions.jsonl in the data room.
const mirrored = readFileSync(
  path.join(process.env.DATAROOM_DIR, "Customers", "acme-bank", "interactions.jsonl"),
  "utf8",
);
assert.deepEqual(JSON.parse(mirrored.trim().split("\n").at(-1)), interaction);

// --- resolve_followup -------------------------------------------------------

const followUp = scopedFollowUps[0];
const resolved = await sor.resolveFollowUp("acme-bank", followUp.ticketId);
assert.equal(resolved.ticketId, followUp.ticketId);
assert.equal(resolved.ticketStatus, "Resolved");
assert.ok(
  !(await sor.listFollowUps("acme-bank")).some((f) => f.ticketId === followUp.ticketId),
  "resolved follow-up must drop out of the open list",
);
await assert.rejects(
  () => sor.resolveFollowUp("acme-bank", "TCK-does-not-exist"),
  /not found for customer acme-bank/,
);

console.log("system-of-record fallback tests ok");
