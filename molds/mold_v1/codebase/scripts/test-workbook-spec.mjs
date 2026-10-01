/**
 * Fallback-path test for the deterministic workbook-spec builder
 * (agent/lib/workbook-spec.ts). Runs with NO database URL, so the system of
 * record is the in-memory fallback, seeded from the test fixture — no
 * Postgres connection is ever attempted. The spec is a pure function of the
 * store + people seed, so every assertion is exact.
 *
 * Usage:
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-workbook-spec.mjs
 */
import assert from "node:assert/strict";

// Force the fallback path: no DB URL.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

// Seed the in-memory store. These assertions target a customer that used to
// live in data/customers.json until c7b929c emptied it; the fixture now
// belongs to the tests, not to shipped product data.
const { seedFixtureStore } = await import("./lib/test-fixture.mjs");
const seededIds = await seedFixtureStore();

const { getDb } = await import("../agent/lib/db/index.ts");
const {
  buildCustomerWorkbookSpecs,
  buildDomainWorkbookSpec,
  deriveInteractionDigestRow,
  WORKBOOK_DOMAINS,
} = await import("../agent/lib/workbook-spec.ts");

assert.equal(getDb(), null, "no DB URL is set, getDb() must return null (fallback path)");

const NOW = "2026-07-10T12:00:00Z";

/* -------------------------------------------------------------------------- */
/* (1) Seven specs, fixed domain order, matching workbook paths                */
/* -------------------------------------------------------------------------- */

const specs = await buildCustomerWorkbookSpecs({ customerId: "acme-bank", now: NOW });
const DOMAIN_ORDER = ["Customers", "Platform", "Deployments", "Solutions", "Implementation", "Tickets", "People"];

assert.equal(specs.length, 7, "one spec per domain");
assert.deepEqual([...WORKBOOK_DOMAINS], DOMAIN_ORDER, "WORKBOOK_DOMAINS is the fixed data-model order");
assert.deepEqual(specs.map((s) => s.domain), DOMAIN_ORDER, "specs in fixed domain order");
for (const s of specs) {
  assert.equal(s.workbook, `${s.domain}/Master.xlsx`, `workbook path for ${s.domain}`);
}

const byDomain = Object.fromEntries(specs.map((s) => [s.domain, s]));

/* -------------------------------------------------------------------------- */
/* (2) Tickets carries three sheets                                            */
/* -------------------------------------------------------------------------- */

assert.deepEqual(
  byDomain.Tickets.sheets.map((sh) => sh.name),
  ["Tickets", "Interactions", "Interaction Digest"],
  "Tickets workbook: Tickets + Interactions + Interaction Digest",
);
assert.deepEqual(byDomain.Customers.sheets.map((s) => s.name), ["Customers"]);
assert.deepEqual(byDomain.People.sheets.map((s) => s.name), ["Internal Staff", "Customer Stakeholders"]);

/* -------------------------------------------------------------------------- */
/* (3) Columns — exact for anchor sheets, length for the rest                  */
/* -------------------------------------------------------------------------- */

const CUSTOMERS_COLUMNS = [
  "customer_id", "customer_name", "tier", "lifecycle_stage", "status", "health_score",
  "fde_owner", "ae_owner", "arr", "arr_currency", "seats", "external_account_id",
  "legal_entity_name", "account_region", "contract_status", "renewal_forecast",
  "renewal_risk_reason", "expansion_potential_arr", "health_reason", "company_domain",
  "vertical", "regulatory_profile", "business_owner_email", "technical_owner_email",
  "executive_sponsor_email", "value_realization_stage", "target_annual_value",
  "realized_annual_value", "success_criteria", "value_period_start", "value_period_end",
  "value_evidence_status", "value_evidence_url", "last_business_review_date",
  "next_business_review_date", "contract_start", "renewal_date", "industry_segment",
];
const INTERACTIONS_COLUMNS = [
  "interaction_id", "customer_id", "interaction_at", "interaction_type", "source_system",
  "source_id", "source_link", "summary", "note", "outcome", "participant_emails",
  "related_ticket_ids", "related_solution_ids", "related_deployment_ids", "next_action",
  "next_action_owner_email", "next_action_due_date", "sentiment", "sensitivity",
  "recorded_by_email", "recorded_at",
];
const INTERNAL_STAFF_COLUMNS = ["customer_id", "staff_role", "name", "title", "employer_org", "email", "last_contact"];
const CUSTOMER_STAKEHOLDERS_COLUMNS = ["customer_id", "stakeholder_role", "name", "title", "employer_org", "email", "last_contact"];
const INTERACTION_DIGEST_COLUMNS = ["customer_id", "customer_name", "interactions", "date_range", "last_touch", "open_next_actions", "sentiment", "digest"];

const customersSheet = byDomain.Customers.sheets[0];
const ticketsSheet = byDomain.Tickets.sheets[0];
const interactionsSheet = byDomain.Tickets.sheets[1];
const digestSheet = byDomain.Tickets.sheets[2];
const staffSheet = byDomain.People.sheets[0];
const stakeholderSheet = byDomain.People.sheets[1];

assert.deepEqual(customersSheet.columns, CUSTOMERS_COLUMNS, "Customers columns exact");
assert.equal(customersSheet.columns.length, 38, "Customers has 38 columns");
assert.deepEqual(interactionsSheet.columns, INTERACTIONS_COLUMNS, "Interactions columns exact");
assert.equal(interactionsSheet.columns.length, 21, "Interactions has 21 columns");
assert.deepEqual(staffSheet.columns, INTERNAL_STAFF_COLUMNS, "Internal Staff columns exact");
assert.deepEqual(stakeholderSheet.columns, CUSTOMER_STAKEHOLDERS_COLUMNS, "Customer Stakeholders columns exact");
assert.deepEqual(digestSheet.columns, INTERACTION_DIGEST_COLUMNS, "Interaction Digest columns exact");

assert.equal(byDomain.Platform.sheets[0].columns.length, 35, "Platform has 35 columns");
assert.equal(byDomain.Deployments.sheets[0].columns.length, 53, "Deployments has 53 columns");
assert.equal(byDomain.Solutions.sheets[0].columns.length, 75, "Solutions has 75 columns");
assert.equal(byDomain.Implementation.sheets[0].columns.length, 51, "Implementation has 51 columns");
assert.equal(ticketsSheet.columns.length, 65, "Tickets has 65 columns");

/* -------------------------------------------------------------------------- */
/* (4) Rows — pinned against the acme-bank seed                                */
/* -------------------------------------------------------------------------- */

// Customers: exactly 1 row, correct prefix + numeric health_score.
assert.equal(customersSheet.rows.length, 1, "Customers: one row for one customer");
const custRow = customersSheet.rows[0];
assert.deepEqual(
  custRow.slice(0, 5),
  ["acme-bank", "Acme Bank", "Enterprise", "Expansion", "On Track"],
  "Customers row prefix",
);
assert.equal(custRow[CUSTOMERS_COLUMNS.indexOf("health_score")], 92, "health_score cell is the NUMBER 92");
assert.equal(typeof custRow[CUSTOMERS_COLUMNS.indexOf("health_score")], "number", "health_score stays a number");
assert.equal(custRow[CUSTOMERS_COLUMNS.indexOf("fde_owner")], "priyesh@example.com", "fde_owner cell");

// Tickets: ids in seed order.
assert.deepEqual(
  ticketsSheet.rows.map((r) => r[0]),
  ["TCK-1001", "TCK-1002", "TCK-1003"],
  "Tickets rows carry the three acme ticket ids",
);

// Interactions: exactly one, the QBR.
assert.equal(interactionsSheet.rows.length, 1, "acme has one interaction");
assert.equal(interactionsSheet.rows[0][0], "INT-ACME-2026-07-03-QBR", "interaction_id cell");

// Interaction Digest: exactly one derived row.
assert.equal(digestSheet.rows.length, 1, "one digest row per customer");
const dRow = digestSheet.rows[0];
assert.equal(dRow[0], "acme-bank", "digest customer_id");
assert.equal(dRow[1], "Acme Bank", "digest customer_name");
assert.equal(dRow[2], 1, "digest interactions count (number)");
assert.equal(typeof dRow[2], "number", "interactions is a number");
assert.equal(dRow[3], "2026-07-03", "digest date_range collapses to a single day");
assert.equal(dRow[4], "2026-07-03", "digest last_touch");
assert.equal(dRow[5], 1, "digest open_next_actions (number)");
assert.equal(typeof dRow[5], "number", "open_next_actions is a number");
assert.equal(dRow[6], "positive", "digest sentiment");
assert.match(String(dRow[7]), /qbr/i, "digest narrative mentions the qbr interaction type");

// deriveInteractionDigestRow matches the sheet row exactly.
const { getCustomer } = await import("../agent/lib/system-of-record.ts");
const acme = await getCustomer("acme-bank");
assert.deepEqual(deriveInteractionDigestRow(acme), dRow, "exported digest helper == sheet row");

// People: internal staff = 2 acme rows (priyesh + rohan); stakeholders all acme.
assert.equal(staffSheet.rows.length, 2, "two internal-staff rows for acme");
assert.deepEqual(
  staffSheet.rows.map((r) => r[INTERNAL_STAFF_COLUMNS.indexOf("email")]).sort(),
  ["priyesh@example.com", "rohan@example.com"],
  "acme internal staff emails",
);
for (const r of staffSheet.rows) assert.equal(r[0], "acme-bank", "staff row customer_id");
assert.ok(stakeholderSheet.rows.length >= 1, "at least one stakeholder for acme");
for (const r of stakeholderSheet.rows) assert.equal(r[0], "acme-bank", "stakeholder row customer_id");

/* -------------------------------------------------------------------------- */
/* buildDomainWorkbookSpec parity + determinism                                */
/* -------------------------------------------------------------------------- */

const oneTickets = await buildDomainWorkbookSpec({ customerId: "acme-bank", domain: "Tickets", now: NOW });
assert.deepEqual(oneTickets, byDomain.Tickets, "single-domain build == the same domain in the full build");
assert.deepEqual(
  await buildCustomerWorkbookSpecs({ customerId: "acme-bank", now: NOW }),
  specs,
  "buildCustomerWorkbookSpecs is deterministic",
);

/* -------------------------------------------------------------------------- */
/* (5) Unknown customer rejects                                                */
/* -------------------------------------------------------------------------- */

await assert.rejects(
  () => buildCustomerWorkbookSpecs({ customerId: "no-such-customer", now: NOW }),
  /Unknown account: no-such-customer/,
  "unknown customer rejects (all-domains)",
);
await assert.rejects(
  () => buildDomainWorkbookSpec({ customerId: "no-such-customer", domain: "Customers", now: NOW }),
  /Unknown account: no-such-customer/,
  "unknown customer rejects (single-domain)",
);

/* -------------------------------------------------------------------------- */
/* (6) The profile's own fields are columns of Master.xlsx (mold_v1-089)       */
/* -------------------------------------------------------------------------- */

{
  const { upsertCustomer } = await import("../agent/lib/system-of-record.ts");
  const declared = {
    account: [{ key: "house_view", label: "House view", type: "pick_list", options: ["Positive", "Negative"] }],
    deployments: [
      { key: "rating", label: "Rating", type: "pick_list", options: ["Buy", "Hold", "Sell"] },
      { key: "target_price", label: "Target price", type: "number" },
    ],
    implementations: [{ key: "coverage_priority", label: "Coverage priority", type: "text" }],
  };
  const acme = await (await import("../agent/lib/system-of-record.ts")).getCustomer("acme-bank");
  const depId = acme.deployments[0].deploymentId;
  await upsertCustomer({ id: "acme-bank", custom: { house_view: "Positive" }, deployments: [{ deploymentId: depId, custom: { rating: "Buy", target_price: "1,250" } }], implementation: { custom: { coverage_priority: "Core" } } }, undefined, { declared });
  const sheetOf = async (domain, name) => (await buildDomainWorkbookSpec({ customerId: "acme-bank", domain, now: NOW, declared })).sheets.find((x) => x.name === name);
  const dep = await sheetOf("Deployments", "Deployments");
  assert.deepEqual(dep.columns.slice(-2), ["rating", "target_price"], "the deployments' own fields are the last columns, by key");
  assert.deepEqual(dep.rows[0].slice(-2), ["Buy", 1250], "…with each row's values (a number stays a number)");
  const cust = await sheetOf("Customers", "Customers");
  assert.equal(cust.columns.at(-1), "house_view");
  assert.equal(cust.rows[0].at(-1), "Positive");
  const impl = await sheetOf("Implementation", "Implementation");
  assert.deepEqual([impl.columns.at(-1), impl.rows[0].at(-1)], ["coverage_priority", "Core"]);
  const none = await buildDomainWorkbookSpec({ customerId: "acme-bank", domain: "Deployments", now: NOW });
  assert.equal(none.sheets[0].columns.length, dep.columns.length - 2, "a profile that declares none gets the sheet it always got");
}

console.log("test-workbook-spec: all assertions passed (fallback path, no Postgres).");
