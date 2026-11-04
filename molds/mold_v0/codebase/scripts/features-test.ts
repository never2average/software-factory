// The features registry (mold_v0-219; src/features.json, src/features.ts): each capability flag on and off, in one
// build whose fixture asks for every capability, proving that the flag alone hides or shows the capability's routes,
// MCP tools and scheduler jobs (the console's pages and sidebar entries: scripts/console-sidebar-test.ts and
// gen-packs' web/src/config/features.generated.ts, checked here too).
//   npm run test:features
//
// 1. The registry: twelve flags, each with a default, words for on and off, and a request signal; the profile's
//    `features` over its legacy keys over the default.
// 2. Zero packs: only health_history is asked for (no session engine); nothing else is on.
// 3. The fixture (scripts/fixtures/packs/fixture_embedded, with credentials, company email, due dates, an encrypted field,
//    a check and a private-network kind added): with the defaults every pack-asked capability is on and the two opt-in
//    toggles (audit, on-premises runners) are off; then each flag is turned (off for the first, on for the second) and
//    its routes, tools and jobs go (or come) while every other capability stays as it was.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP } from "./lib/test-world.js";
import { installEmbedded } from "./lib/embedded-fixture.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const stack = (r: unknown) => ((r as { stack?: unknown[] }).stack ?? []).length;
const pass = (_q: unknown, _s: unknown, n: () => void) => n();

try {
  const F = await import("../src/features.js");
  const { createOrg } = await import("../src/auth.js");
  const { enabledJobs, deliveriesOn, webhooksOn } = await import("../src/health-tabs.js");
  const { emailAppRouter } = await import("../src/email-routes.js");
  const { noticeAppRouter } = await import("../src/schedule-routes.js");
  const { auditAppRouter } = await import("../src/audit-trail.js");
  const { ledgerAppRouter } = await import("../src/ledger.js");
  const { checkAppRouter } = await import("../src/checks.js");
  const { onPremAppRouter } = await import("../src/onprem-runner-routes.js");
  const { developerApiRouter } = await import("../src/developer-api.js");
  const { onPremAvailable } = await import("../src/onprem-runners.js");
  const { clockAreas, clockTools, clockStepsOn } = await import("../src/record-clocks.js");
  const { dueAreas } = await import("../src/schedules.js");
  const { encryptedAreas } = await import("../src/encrypted-fields-migration.js");
  const { healthSamplingOn } = await import("../src/health-samples.js");
  const { companyEmailWired } = await import("../src/company-email.js");
  const { declaredChecks } = await import("../src/checks.js");
  const { developerSurface } = await import("../src/developer-surface.js");
  const rec = await import("../src/record-areas.js");

  // ---------- 1. the registry ----------
  {
    const reg = JSON.parse(readFileSync(path.join(ROOT, "src", "features.json"), "utf8"));
    assert.deepEqual(F.FEATURE_IDS, ["customer_key_vault", "company_email", "scheduled_alerts", "record_clocks", "audit.data", "audit.platform", "audit.sign",
      "onprem_runners", "developer_surface", "declarative_checks", "encrypted_fields", "health_history"]);
    assert.equal(reg.flags.length, 12);
    for (const f of F.FEATURES) {
      assert.ok(f.short && f.label && f.about && f.off && f.requested_words && f.since, `${f.id}: documented`);
      assert.equal(typeof f.default, "boolean", `${f.id}: a default`);
    }
    // defaults: on for what a pack declared before the registry, off for the opt-in toggles
    const off = F.FEATURES.filter((f) => !f.default).map((f) => f.id);
    assert.deepEqual(off, ["audit.data", "audit.platform", "audit.sign", "onprem_runners"]);
    // the profile's features over the legacy key over the default
    assert.equal(F.featureSetting("audit.data", {}), false);
    assert.equal(F.featureSetting("audit.data", { audit: { data: true } }), true);
    assert.equal(F.featureSetting("audit.data", { audit: { data: true }, features: { "audit.data": false } }), false);
    assert.equal(F.featureSetting("onprem_runners", { onprem_runners: true }), true);
    assert.equal(F.featureSetting("company_email", { features: { company_email: false } }), false);
    assert.equal(F.featureSetting("company_email", {}), true);
    console.log("✓ the registry: 12 flags, each documented with a default; profile.features over the legacy key over the default");
  }

  // ---------- 2. zero packs ----------
  {
    await installEmbedded(null);
    assert.deepEqual(F.featureStates().filter((s) => s.requested).map((s) => s.id), ["audit.data", "audit.platform", "audit.sign", "health_history"]);
    assert.equal(F.featuresOnWords(), "health");
    console.log("✓ zero packs: nothing asked for but the audit toggles (profile only) and health history; on: health");
  }

  // ---------- 3. the fixture asking for everything ----------
  await installEmbedded((j) => {
    j.credentials = [{ name: "api_token", label: "API token", bound_to: "workspace", deliver_as: { env: "API_TOKEN" } }];
    j.email = { sender: { allow: true } };
    const tickets = j.record_areas.find((a: { name: string }) => a.name === "tickets");
    tickets.due = { field: "due", within_days: 7 };
    const findings = j.record_areas.find((a: { name: string }) => a.name === "findings");
    findings.fields.push({ name: "secret_note", label: "Secret note", type: "text", encrypted: true });
    j.checks = [{ name: "has_ticket", label: "Is there such a ticket?", inputs: { summary: "string" }, rule: { area: "tickets", match: { summary: "$summary" }, latest_by: "updated_at", require: [{ field: "state", ne: "closed" }] } }];
    j.job_kinds[0].private_network = true;
  });
  const org = (await createOrg(`Features ${STAMP}`)).org;
  const tools = async () => { const c = await connect(org); try { return (await c.client.listTools()).tools.map((t) => t.name); } finally { await c.close(); } };
  const jobs = () => enabledJobs().map((j) => j.id);

  /** What each capability shows in this build, read from its own gates. */
  const probe = async () => {
    const t = await tools();
    return {
      company_email: companyEmailWired() && stack(emailAppRouter()) > 0,
      scheduled_alerts: stack(noticeAppRouter()) > 0 && dueAreas().length > 0 && clockStepsOn(),
      record_clocks: clockAreas().length > 0 && clockTools().length > 0 && jobs().includes("record_clocks") && t.includes("list_due_records"),
      "audit.data": stack(auditAppRouter(pass as never)) > 0 && t.includes("read_audit_trail"),
      "audit.sign": stack(ledgerAppRouter(pass as never)) > 0 && t.includes("verify_audit_trail") && jobs().includes("ledger_checkpoints"),
      onprem_runners: onPremAvailable() && stack(onPremAppRouter()) > 0,
      developer_surface: !!developerSurface() && stack(developerApiRouter()) > 0 && jobs().includes("event_outbox") && webhooksOn(),
      declarative_checks: declaredChecks().length > 0 && stack(checkAppRouter(pass as never)) > 0 && t.includes("check_has_ticket"),
      encrypted_fields: encryptedAreas().length > 0 && jobs().includes("encrypted_fields"),
      health_history: healthSamplingOn() && jobs().includes("health_samples"),
    } as Record<string, boolean>;
  };

  F.setFeaturesForTest(null);
  const defaults = await probe();
  assert.deepEqual(defaults, { company_email: true, scheduled_alerts: true, record_clocks: true, "audit.data": false, "audit.sign": false, onprem_runners: false,
    developer_surface: true, declarative_checks: true, encrypted_fields: true, health_history: true }, "with the defaults: every pack-asked capability on, the toggles off");
  assert.equal(F.featuresOnWords(), "vault, email, alerts, clocks, developer, checks, encrypted, health");
  assert.equal(deliveriesOn(), true);
  console.log(`✓ defaults: on ${F.featuresOnWords()}; audit and runners off (their routes, tools and jobs absent)`);

  // Each flag turned from its default: its own capability flips, every other one stays.
  const turns: [import("../src/features.js").FeatureId, boolean, string][] = [
    ["company_email", false, "company_email"],
    ["scheduled_alerts", false, "scheduled_alerts"],
    ["record_clocks", false, "record_clocks"],
    ["audit.data", true, "audit.data"],
    ["onprem_runners", true, "onprem_runners"],
    ["developer_surface", false, "developer_surface"],
    ["declarative_checks", false, "declarative_checks"],
    ["encrypted_fields", false, "encrypted_fields"],
    ["health_history", false, "health_history"],
  ];
  for (const [id, value, key] of turns) {
    F.setFeaturesForTest({ [id]: value });
    const got = await probe();
    const want: Record<string, boolean> = { ...defaults, [key]: value };
    // the clock steps are alerts: with the clocks off and due dates still there, alerts stay on (due-date notices)
    assert.deepEqual(got, want, `${id} = ${value}: only its own capability changes`);
    assert.equal(F.featureOn(id), value, `${id}: featureOn follows the flag`);
    console.log(`✓ ${id} = ${value}: ${value ? "its routes, tools and jobs appear" : "its routes, tools and jobs are gone"}; nothing else changes`);
  }

  // audit.sign: needs a trail to sign (the factory refuses it alone); with audit.data on, its route, tool and job appear.
  F.setFeaturesForTest({ "audit.data": true, "audit.sign": true });
  assert.deepEqual(await probe(), { ...defaults, "audit.data": true, "audit.sign": true });
  console.log("✓ audit.sign = true (with audit.data): /api/ledger, verify_audit_trail and the checkpoint job appear");

  // audit.platform: its own trail (the platform's) on, the data trail's tool lists it too.
  F.setFeaturesForTest({ "audit.platform": true });
  assert.equal(stack(auditAppRouter(pass as never)) > 0, true, "the platform trail mounts /api/audit");
  assert.ok((await tools()).includes("read_audit_trail"));
  console.log("✓ audit.platform = true: /api/audit and read_audit_trail appear");

  // Encrypted fields off: reveal is refused (values stay masked: fail closed).
  F.setFeaturesForTest({ encrypted_fields: false });
  await assert.rejects(rec.revealFor(org.orgId, "findings", "x", null), /Encrypted fields are off/);
  console.log("✓ encrypted_fields = false: reveal answers not found (values stay masked)");

  // The legacy keys still turn their flags (setAuditForTest, setOnPremRunnersForTest as the profile's audit/onprem keys).
  F.setFeaturesForTest(null);
  const audit = await import("../src/audit-trail.js");
  audit.setAuditForTest({ data: true });
  assert.equal(audit.dataTrailOn(), true);
  audit.setAuditForTest(null);
  const { setOnPremRunnersForTest } = await import("../src/profile.js");
  setOnPremRunnersForTest(true);
  assert.equal(F.featureOn("onprem_runners"), true);
  setOnPremRunnersForTest(null);
  assert.equal(F.featureOn("onprem_runners"), false);
  console.log("✓ the legacy toggles (profile.audit.*, profile.onprem_runners) still read through the registry");

  await installEmbedded(null);
  console.log("FEATURES TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
