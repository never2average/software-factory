/**
 * Tests for the deployment profile's OWN fields on the two record areas (`domains.<area>.custom_fields`,
 * docs/DEPLOYMENT_PROFILE.md): the one validator every write path shares (agent/lib/custom-fields.ts), the
 * agent's write path (applyCustomFields in agent/lib/system-of-record.ts), the MCP tool inputs, the migration,
 * and a ratchet: any file that writes the two tables must go through the validator.
 *
 * The generator's own rules for custom_fields are in scripts/test-deployment-profile.mjs.
 *
 * Runs offline with plain node + assert — no database, no network.
 * Usage: npm run test:custom-fields
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const ROOT = new URL("..", import.meta.url).pathname;
const { validateCustom, asCustomValues, displayCustom, inputTypeOf, describeCustomField, customFieldsOf } = await import("../agent/lib/custom-fields.ts");

// Two verticals, to keep the feature general: an equity-research desk's reports, a field-service team's site visits.
const REPORT = [
  { key: "rating", label: "Rating", type: "pick_list", options: ["Buy", "Add", "Hold", "Reduce", "Sell"], required: true },
  { key: "period", label: "Period", type: "text" },
  { key: "target_price", label: "Target price", type: "number" },
  { key: "data_completeness", label: "Data completeness", type: "percent" },
  { key: "publish_date", label: "Publish date", type: "date" },
  { key: "source_link", label: "Source filing", type: "link" },
  { key: "reviewer", label: "Reviewer", type: "email" },
  { key: "thesis", label: "Thesis in brief", type: "long_text" },
];
const VISIT = [
  { key: "inspection_date", label: "Inspection date", type: "date", required: true },
  { key: "permit_link", label: "Permit", type: "link" },
  { key: "crew_size", label: "Crew size", type: "number" },
];
const create = (input, fields = REPORT) => validateCustom("deployments", input, { mode: "create", fields });
const update = (input, existing, fields = REPORT) => validateCustom("deployments", input, { mode: "update", existing, fields });
const refused = (result, pattern) => {
  assert.equal(result.ok, false, `should be refused: ${JSON.stringify(result)}`);
  assert.match(result.errors.join(" "), pattern);
  for (const e of result.errors) assert.match(e, /^[A-Z"`].*\.$/, `a plain sentence: ${e}`);
};

// --- the default build declares nothing ------------------------------------------------------------------------

// Only a build that declares none can say so: a build with its own profile (a pack's, see docs/SUBAGENT_PACKS.md)
// runs the rest of this file unchanged, because every other case passes its fields in.
if (customFieldsOf("deployments").length === 0 && customFieldsOf("implementations").length === 0) {
  assert.deepEqual(validateCustom("deployments", undefined, { mode: "create" }), { ok: true, values: {} }, "no custom fields, nothing sent: nothing to store");
  refused(validateCustom("deployments", { rating: "Buy" }, { mode: "create" }), /no custom field "rating" here: this deployment's profile declares none/);
}

// --- create: normalised values, required enforced, unknown keys refused ------------------------------------------

assert.deepEqual(
  create({ rating: "buy", period: "  Q2 FY26 ", target_price: "1,250.50", data_completeness: "85%", publish_date: "2026-07-31", source_link: "https://example.com/filing.pdf", reviewer: "asha@desk.in", thesis: "Line one\nline two" }),
  { ok: true, values: { rating: "Buy", period: "Q2 FY26", target_price: 1250.5, data_completeness: 85, publish_date: "2026-07-31", source_link: "https://example.com/filing.pdf", reviewer: "asha@desk.in", thesis: "Line one\nline two" } },
);
assert.deepEqual(create({ rating: "Hold", target_price: 0, data_completeness: 100 }).values, { rating: "Hold", target_price: 0, data_completeness: 100 }, "0 and 100 are values, not blanks");
assert.deepEqual(create({ rating: "Hold", period: "", thesis: null }).values, { rating: "Hold" }, "a blank optional field is simply not stored");
refused(create({}), /"Rating" \(rating\) is required\./);
refused(create(undefined), /"Rating" \(rating\) is required\./);
assert.deepEqual(create({ rating: "" }).errors, ['"Rating" (rating) is required.'], "blank on a create is not filled in, not cleared; said once");
refused(create({ rating: "Hold", ratting: "Buy" }), /There is no custom field "ratting" here\. The custom fields are: `rating` \("Rating", one of "Buy" \| "Add"/);
refused(create({ rating: "Hold", region: "x" }), /no custom field "region"/);
refused(create([]), /`custom` must be an object/);
refused(create("rating=Buy"), /`custom` must be an object/);
assert.equal(create({ rating: "Strong buy", target_price: "lots", publish_date: "31/07/2026" }).errors.length, 3, "every problem is reported at once, not the first");

// --- each type -----------------------------------------------------------------------------------------------------

const one = (key, value) => create({ rating: "Hold", [key]: value });
refused(one("rating", "Strong buy"), /"Rating" \(rating\) must be one of: Buy, Add, Hold, Reduce, Sell\./);
refused(one("period", "two\nlines"), /single line of text/);
refused(one("period", "x".repeat(501)), /too long/);
assert.equal(one("period", 2026).values.period, "2026", "a number sent for a text field is kept as text");
for (const bad of ["abc", "12abc", "1e5", "NaN", "Infinity", "1,2", "--4"]) refused(one("target_price", bad), /"Target price" \(target_price\) must be a number, for example 1250\.5\./);
for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) refused(one("target_price", bad), /must be a number/);
assert.equal(one("target_price", "-12.5").values.target_price, -12.5);
assert.equal(one("target_price", " 1,000,000 ").values.target_price, 1000000);
for (const bad of [-1, 100.01, "101", "150%"]) refused(one("data_completeness", bad), /is a percentage: it must be from 0 to 100\./);
refused(one("data_completeness", "most"), /must be a number from 0 to 100\./);
assert.equal(one("data_completeness", "62.5 %").values.data_completeness, 62.5);
for (const bad of ["2026-02-30", "2026-13-01", "31-07-2026", "2026/07/31", "2026-7-31", "tomorrow", "2026-07-31T00:00:00Z"]) refused(one("publish_date", bad), /must be a real date written as year-month-day, for example 2026-07-31\./);
assert.equal(one("publish_date", "2028-02-29").values.publish_date, "2028-02-29", "a leap day is a real date");
for (const bad of ["asha", "asha@desk", "a b@desk.in", "@desk.in"]) refused(one("reviewer", bad), /must be an email address/);
for (const bad of ["example.com/x", "ftp://example.com/x", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//example.com"]) refused(one("source_link", bad), /must be a web link that starts with https:\/\/ or http:\/\/\./);
assert.equal(one("source_link", "http://example.com").values.source_link, "http://example.com/");
for (const bad of [["Buy"], { v: "Buy" }, true]) refused(one("rating", bad), /must be a single text value, not a list or an object\./);
refused(one("target_price", [1]), /must be a single number/);

// --- update: a partial change MERGES, null / "" clears, required cannot be cleared ---------------------------------

const stored = { rating: "Hold", target_price: 900, period: "Q1 FY26" };
assert.deepEqual(update({ target_price: 1100 }, stored).values, { rating: "Hold", target_price: 1100, period: "Q1 FY26" }, "unmentioned keys are kept");
assert.deepEqual(update({ period: null }, stored).values, { rating: "Hold", target_price: 900 }, "null clears");
assert.deepEqual(update({ period: "" }, stored).values, { rating: "Hold", target_price: 900 }, '"" clears');
assert.deepEqual(update(undefined, stored).values, stored, "nothing sent, nothing changed");
assert.deepEqual(update({ target_price: 1 }, {}).values, { target_price: 1 }, "required is a rule for creating: a record that predates the field can still be edited");
refused(update({ rating: null }, stored), /"Rating" \(rating\) is required, so it cannot be cleared\./);
refused(update({ nope: 1 }, stored), /no custom field "nope"/);
assert.deepEqual(stored, { rating: "Hold", target_price: 900, period: "Q1 FY26" }, "the stored object is never mutated");
// A key the profile no longer declares is carried through, never deleted by an unrelated edit.
assert.deepEqual(update({ target_price: 5 }, { ...stored, legacy_score: 7 }).values.legacy_score, 7);
// Garbage in the column reads as nothing set.
assert.deepEqual(asCustomValues(null), {});
assert.deepEqual(asCustomValues(["a"]), {});
assert.deepEqual(asCustomValues({ a: 1, b: "x", c: null, d: { e: 1 }, f: true }), { a: 1, b: "x" });

// --- the other vertical, the other area -----------------------------------------------------------------------------

assert.deepEqual(validateCustom("implementations", { inspection_date: "2026-10-02", crew_size: "4" }, { mode: "create", fields: VISIT }).values, { inspection_date: "2026-10-02", crew_size: 4 });
refused(validateCustom("implementations", { crew_size: 4 }, { mode: "create", fields: VISIT }), /"Inspection date" \(inspection_date\) is required\./);

// --- how a value and a field read ------------------------------------------------------------------------------------

assert.equal(displayCustom({ type: "percent" }, 85), "85%");
assert.equal(displayCustom({ type: "number" }, 1250.5), "1,250.5");
assert.equal(displayCustom({ type: "percent" }, 0), "0%", "zero is a value");
assert.equal(displayCustom({ type: "text" }, undefined), "");
assert.deepEqual(["text", "long_text", "number", "percent", "date", "email", "link", "pick_list"].map(inputTypeOf), ["text", "text", "number", "number", "date", "email", "url", "text"]);
assert.equal(describeCustomField(REPORT[0]), '`rating` ("Rating", one of "Buy" | "Add" | "Hold" | "Reduce" | "Sell", required)');
assert.equal(describeCustomField(VISIT[1]), '`permit_link` ("Permit", http(s) link)');

// --- the agent's write path: upsert_customer -> applyCustomFields -------------------------------------------------------

const { applyCustomFields, customerToDbRows } = await import("../agent/lib/system-of-record.ts");
const declared = { deployments: REPORT, implementations: VISIT };
const dep = (extra) => ({ deploymentId: "Q2FY26-results", ...extra });
const existing = { id: "hdfc", name: "HDFC", deployments: [dep({ custom: { rating: "Hold", target_price: 900 } })], implementation: { rolloutId: "large-caps", custom: { inspection_date: "2026-01-05" } } };

// A patch replaces deployments[] wholesale; `custom` still merges per record, keyed by deploymentId.
let out = applyCustomFields({ id: "hdfc", deployments: [dep({ custom: { target_price: "1,100" } })] }, existing, declared);
assert.deepEqual(out.deployments[0].custom, { rating: "Hold", target_price: 1100 });
out = applyCustomFields({ id: "hdfc", deployments: [dep({ notes: "restated" })] }, existing, declared);
assert.deepEqual(out.deployments[0].custom, { rating: "Hold", target_price: 900 }, "a patch that does not mention custom keeps it");
out = applyCustomFields({ id: "hdfc", implementation: { rolloutId: "large-caps", custom: { crew_size: 3 } } }, existing, declared);
assert.deepEqual(out.implementation.custom, { inspection_date: "2026-01-05", crew_size: 3 });
// A NEW record is a create: required enforced, and the error says which record.
assert.throws(() => applyCustomFields({ id: "hdfc", deployments: [existing.deployments[0], dep({ deploymentId: "Q3FY26-results", custom: { target_price: 1 } })] }, existing, declared), /nothing was written\. Q3FY26-results: "Rating" \(rating\) is required\./);
assert.throws(() => applyCustomFields({ id: "new-co", implementation: { custom: {} } }, null, declared), /new-co: "Inspection date" \(inspection_date\) is required\./);
assert.throws(() => applyCustomFields({ id: "hdfc", deployments: [dep({ custom: { ratting: "Buy" } })] }, existing, declared), /no custom field "ratting"/);
// Fields declared, none required, none sent: the record is written without an empty `custom`.
const OPTIONAL = { deployments: REPORT.map((f) => ({ ...f, required: false })), implementations: [] };
assert.deepEqual(applyCustomFields({ id: "new-co", deployments: [dep({})] }, null, OPTIONAL), { id: "new-co", deployments: [dep({})] });
// A patch that touches neither area is passed through untouched.
const scalar = { id: "hdfc", tier: "Enterprise" };
assert.deepEqual(applyCustomFields(scalar, existing, declared), scalar);
// The default build: nothing declared, nothing sent -> byte-identical patch; an invented key is still refused.
const NONE = { deployments: [], implementations: [] }; // said out loud, so a build with its own profile runs this too
const plain = { id: "acme", deployments: [dep({})], implementation: { rolloutId: "r1" } };
assert.deepEqual(applyCustomFields(plain, null, NONE), plain);
assert.throws(() => applyCustomFields({ id: "acme", deployments: [dep({ custom: { rating: "Buy" } })] }, null, NONE), /declares none/);

// The column is NOT NULL: a record without custom values is written as {}, never as fullRow's null.
const rows = customerToDbRows({ id: "acme", name: "Acme", deployments: [{ deploymentId: "d1" }, { deploymentId: "d2", custom: { rating: "Buy", gone: null } }], implementation: {} });
assert.deepEqual(rows.deployments.map((d) => d.custom), [{}, { rating: "Buy" }]);
assert.deepEqual(rows.implementation.custom, {});

// --- the MCP tools: `custom` on both write tools, named from the profile when the host knows it ---------------------

const { createTools } = await import("../setup/fde-tools.mjs");
const base = { api: async () => ({}), getOrg: () => null, setOrg() {}, identity: async () => null };
const toolsOf = (ctx) => Object.fromEntries(createTools({ ...base, ...ctx }).map((t) => [t.name, t]));
const generic = toolsOf({});
for (const [tool, list] of [["deployment_upsert", "deployment_list"], ["implementation_upsert", "implementation_list"]]) {
  const custom = generic[tool].inputSchema.properties.custom;
  assert.equal(custom.type, "object");
  assert.ok(custom.description.includes(list) && custom.description.includes("null clears one"), `${tool}: a host that cannot name the fields says how to find them`);
  assert.ok(!generic[tool].inputSchema.required.includes("custom"));
  assert.ok(generic[list].description.includes("`custom`"), `${list} says reads carry custom`);
}
const hosted = toolsOf({ customFields: { deployments: REPORT, implementations: [] } });
assert.ok(hosted.deployment_upsert.inputSchema.properties.custom.description.includes('rating ("Rating", one of Buy | Add | Hold | Reduce | Sell, required on create)'));
assert.ok(hosted.deployment_upsert.inputSchema.properties.custom.description.includes('data_completeness ("Data completeness", percent 0-100)'));
assert.ok(hosted.implementation_upsert.inputSchema.properties.custom.description.includes("declares none"));
// The write tools pass `custom` through to the Ops API untouched: the API is where it is validated.
let sent = null;
await toolsOf({ api: async (method, path, body) => ((sent = { method, path, body }), { item: { id: "x" } }) }).deployment_upsert.handler({ customerId: "hdfc", deploymentId: "d1", custom: { rating: "Buy" } });
assert.deepEqual(sent, { method: "POST", path: "/api/ops/deployments", body: { customerId: "hdfc", deploymentId: "d1", custom: { rating: "Buy" } } });

// --- the migration: one jsonb column per table, no policy touched -----------------------------------------------------

const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8")).entries;
const entry = journal.find((e) => e.tag === "0017_record_custom_fields");
assert.ok(entry, "the migration is in the journal (scripts/migrate-production.mjs applies what the journal lists)");
/**
 * The invariant is ORDER, not "nothing has been added since".
 *
 * This used to assert `entry.idx === journal.length - 1`, which made the test
 * fail the moment anyone wrote the NEXT migration — a green suite that goes red
 * on unrelated, correct work teaches people to ignore it. What actually matters
 * is what the migrator needs: the entry sits at its own index, and its timestamp
 * is later than the entry before it, or drizzle's migrator skips it.
 */
assert.equal(journal[entry.idx]?.tag, entry.tag, "…at its own index in the journal");
assert.ok(entry.when > journal[entry.idx - 1].when, "…later than the one before it, or drizzle's migrator skips it");
const migration = readFileSync(join(ROOT, "drizzle/0017_record_custom_fields.sql"), "utf8");
const statements = migration.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").trim()).filter(Boolean);
assert.deepEqual(statements, [
  `ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;`,
  `ALTER TABLE "implementation" ADD COLUMN IF NOT EXISTS "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;`,
]);
assert.ok(!/POLICY|ROW LEVEL SECURITY|GRANT|DROP/i.test(statements.join("\n")), "adding a column leaves org_isolation exactly as it is");
const schema = readFileSync(join(ROOT, "agent/lib/db/schema.ts"), "utf8");
assert.equal((schema.match(/custom: jsonb\("custom"\)\.\$type<Record<string, string \| number>>\(\)\.notNull\(\)\.default\(\{\}\)/g) ?? []).length, 2, "schema.ts declares the same column on both tables");

// --- the ratchet: whoever writes the two tables goes through the validator ---------------------------------------------

const WRITES = /\.(insert|update)\(\s*(deployments|implementation|deploymentsTable|implementationTable)\s*\)/;
const VALIDATED = /customForWrite\(|applyCustomFields\(/;
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (n === "node_modules" || n.startsWith(".")) return [];
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(n) ? [p] : [];
});
const writers = ["app", "agent", "lib", "services"].flatMap((d) => walk(join(ROOT, d))).filter((f) => WRITES.test(readFileSync(f, "utf8"))).map((f) => f.slice(ROOT.length)).sort();
assert.deepEqual(writers, [
  "agent/lib/system-of-record.ts",
  "app/api/ops/deployments/[id]/route.ts",
  "app/api/ops/deployments/route.ts",
  "app/api/ops/implementations/[id]/route.ts",
  "app/api/ops/implementations/route.ts",
], "a NEW writer of deployments / implementation: run its `custom` through agent/lib/custom-fields.ts, then list it here");
for (const f of writers) assert.match(readFileSync(join(ROOT, f), "utf8"), VALIDATED, `${f} writes the table, so it validates custom`);
// …and every reader the API offers returns the values.
for (const f of ["app/api/ops/deployments/route.ts", "app/api/ops/implementations/route.ts"]) assert.match(readFileSync(join(ROOT, f), "utf8"), /custom: asCustomValues\(/, `${f} returns custom`);

console.log("custom-fields: all assertions passed");
