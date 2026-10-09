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
import { FOLDER } from "../agent/lib/dataroom-folders.ts";
import { readJsonFixture } from "./lib/read-fixture.mjs";
import { DEFAULT_ORG } from "./lib/default-org.mjs";

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
const reference = customerStoreSchema.parse(readJsonFixture(seedUrl));
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
    accountOwner: c.accountOwner,
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

// --- upsert_customer: a patch names the rows and fields it changes ----------
// deployments[] rows by deploymentId and the implementation's fields: a row or field left out keeps its stored
// value, null clears a field, a row goes only with remove: true. (It used to replace both whole: a row not resent
// was deleted, a field not resent blanked.) Postgres does the same in SQL: scripts/test-record-areas-db.mjs.

const acme = await sor.getCustomer("acme-bank");
const [dep0] = acme.deployments;
assert.ok(dep0.region && acme.implementation?.implementationStage, "the fixture has a deployment row and an implementation");
let patched = await sor.upsertCustomer({ id: "acme-bank", deployments: [{ deploymentId: dep0.deploymentId, notes: "restated" }] });
assert.deepEqual(patched.deployments, [{ ...dep0, notes: "restated" }], "one field of one row changes; the rest of the row is kept");
patched = await sor.upsertCustomer({ id: "acme-bank", deployments: [{ deploymentId: "DEP-NEW", environment: "uat", region: "eu-west-1", deployedVersion: "v2", releaseStatus: "in-progress", healthStatus: "unknown" }] });
assert.deepEqual(patched.deployments.map((d) => d.deploymentId), [dep0.deploymentId, "DEP-NEW"], "a new row is added; the row left out is kept");
patched = await sor.upsertCustomer({ id: "acme-bank", deployments: [{ deploymentId: dep0.deploymentId, notes: null }] });
assert.equal(patched.deployments[0].notes, undefined, "null clears a field");
await assert.rejects(sor.upsertCustomer({ id: "acme-bank", deployments: [{ deploymentId: "DEP-HALF", notes: "x" }] }), /Nothing was written\. deploymentId DEP-HALF is a new row, so it needs environment, region, deployedVersion, releaseStatus and healthStatus/);
patched = await sor.upsertCustomer({ id: "acme-bank", deployments: [{ deploymentId: "DEP-NEW", remove: true }] });
assert.deepEqual(patched.deployments.map((d) => d.deploymentId), [dep0.deploymentId], "remove: true deletes exactly that row");
patched = await sor.upsertCustomer({ id: "acme-bank", implementation: { implementationProgressPct: 42 } });
assert.deepEqual(patched.implementation, { ...acme.implementation, implementationProgressPct: 42 }, "one implementation field changes; the rest is kept");
patched = await sor.upsertCustomer({ id: "acme-bank", implementation: { remove: true } });
assert.equal(patched.implementation, undefined, "remove: true deletes the implementation");
// The same rule for every other list (review of #70): naming one row keeps the others, and a delete is said on its own.
const ints = (await sor.getCustomer("acme-bank")).interactions ?? [];
const [t0] = acme.tickets;
patched = await sor.upsertCustomer({ id: "acme-bank", tickets: [{ ticketId: t0.ticketId, ticketNextStep: "changed" }], interactions: [] });
assert.deepEqual(patched.tickets, acme.tickets.map((t) => (t.ticketId === t0.ticketId ? { ...t, ticketNextStep: "changed" } : t)), "one ticket field changes; every other ticket is kept");
assert.deepEqual(patched.interactions ?? [], ints, "an empty interactions list deletes nothing");
await assert.rejects(sor.upsertCustomer({ id: "acme-bank", tickets: [{ ticketId: t0.ticketId, remove: true, summary: "x" }] }), /remove: true deletes the row, so it is sent with nothing else \(it also named summary\)/);
await assert.rejects(sor.upsertCustomer({ id: "acme-bank", deployments: [{ deploymentId: "NOPE", remove: true }] }), /deploymentId NOPE: there is no such deliveries row to remove/);
// A row without its id is a sentence, not zod's JSON issue dump (review of #80).
await assert.rejects(sor.upsertCustomer({ id: "acme-bank", deployments: [{ notes: "no id" }] }), (e) => e.message === "Nothing was written. deployments[0] has no deploymentId: every row names its deploymentId, a new one too.");
await sor.upsertCustomer({ id: "acme-bank", tickets: [{ ticketId: t0.ticketId, ticketNextStep: t0.ticketNextStep }] });
await sor.upsertCustomer({ id: "acme-bank", implementation: acme.implementation, deployments: [{ ...dep0 }] });
assert.deepEqual(await sor.getCustomer("acme-bank"), { ...acme, status: "At Risk" }, "the record is back as it was");

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
  /Unknown account: no-such-customer/,
);

// Document-view mirror: {folder:accounts}/{id}/interactions.jsonl in the data room — the default workspace's own tree (no
// database here, so that is the workspace the account resolves to), never the store's root.
const mirrored = readFileSync(
  path.join(process.env.DATAROOM_DIR, "orgs", DEFAULT_ORG, FOLDER.accounts, "acme-bank", "interactions.jsonl"),
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
  /not found for account acme-bank/,
);

console.log("system-of-record fallback tests ok");
