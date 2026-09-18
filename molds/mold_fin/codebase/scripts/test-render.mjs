/**
 * Fallback-path test for the deterministic HTML report renderers
 * (agent/lib/render-html.ts). Runs with NO database URL, so the system of record
 * reads from the bundled seed JSON (data/customers.json) in memory — no Postgres
 * connection is ever attempted. Output is pinned to a known `now`, exercising the
 * pure (store, now) -> HTML contract.
 *
 * Usage:
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-render.mjs
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
const { renderAccountReport, renderDataroomSummary, escapeHtml } = await import(
  "../agent/lib/render-html.ts"
);

assert.equal(getDb(), null, "no DB URL is set, getDb() must return null (fallback path)");

const NOW = "2026-07-10T12:00:00Z";

/* -------------------------------------------------------------------------- */
/* escapeHtml: full escaping, no raw angle brackets survive                    */
/* -------------------------------------------------------------------------- */

const escaped = escapeHtml('<script>alert("x")</script>');
assert.ok(!escaped.includes("<"), "escapeHtml removes all '<'");
assert.ok(!escaped.includes(">"), "escapeHtml removes all '>'");
assert.ok(escaped.includes("&lt;script&gt;"), "escapeHtml encodes the script tag");
assert.ok(escaped.includes("&quot;"), "escapeHtml encodes double quotes");

/* -------------------------------------------------------------------------- */
/* renderAccountReport({ customerId: "acme-bank" })                            */
/* -------------------------------------------------------------------------- */

const report = await renderAccountReport({ customerId: "acme-bank", now: NOW });

assert.ok(report.toLowerCase().startsWith("<!doctype html>"), "report is a complete HTML document");
assert.ok(report.includes("</html>"), "report closes the html element");
assert.ok(!report.includes("<script"), "report contains NO script tag (zero JS)");

assert.ok(report.includes("Acme Bank"), "report names the customer");
assert.ok(report.includes("TCK-1001"), "report lists the overdue ticket");
assert.ok(report.includes("priyesh@onfinance.in"), "report surfaces the FDE owner");

for (const heading of ["Open Follow-Ups", "Recent Interactions", "Deployments", "Platform"]) {
  assert.ok(report.includes(heading), `report has the '${heading}' section`);
}

// Seed facts: health score 92, deployment + interaction present.
assert.ok(report.includes("92"), "report shows the health score");
assert.ok(report.includes("DEP-ACME-PROD"), "report lists the deployment");
assert.ok(report.includes("2026-07-03"), "report shows the interaction day");

// Signoff-relevant release status is carried through.
assert.ok(
  report.includes("pending-approval") || report.includes("deployed"),
  "report surfaces the deployment release status",
);

/* -------------------------------------------------------------------------- */
/* Unknown customer rejects                                                    */
/* -------------------------------------------------------------------------- */

await assert.rejects(
  () => renderAccountReport({ customerId: "does-not-exist", now: NOW }),
  /Unknown customer: does-not-exist/,
  "unknown customer rejects with a self-describing error",
);

/* -------------------------------------------------------------------------- */
/* Determinism: two consecutive renders are byte-identical                     */
/* -------------------------------------------------------------------------- */

assert.equal(
  await renderAccountReport({ customerId: "acme-bank", now: NOW }),
  report,
  "renderAccountReport is a pure function of (store, now)",
);

/* -------------------------------------------------------------------------- */
/* renderDataroomSummary()                                                     */
/* -------------------------------------------------------------------------- */

const summary = await renderDataroomSummary({ now: NOW });

assert.ok(summary.toLowerCase().startsWith("<!doctype html>"), "summary is a complete HTML document");
assert.ok(summary.includes("</html>"), "summary closes the html element");
assert.ok(!summary.includes("<script"), "summary contains NO script tag");
assert.ok(summary.includes("Acme Bank"), "summary includes the first customer");
assert.ok(summary.includes("Northwind Capital"), "summary includes the second customer");

console.log("test-render: all assertions passed (fallback path, no Postgres).");
