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
// 4. The console (scripts/gen-packs.mjs in build copies of the same fixture, one per flag): the flag alone takes its
//    pages, sidebar entries and Settings tabs away (or brings them), web/src/config/features.generated.ts says so, and
//    what a flag may not do is refused at build (encrypted_fields off over an encrypted field; audit.sign alone).
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const { credentialAppRouter } = await import("../src/credential-routes.js");
  const { mountFileRoutes } = await import("../src/record-files.js");
  // The record file card routes (mold_v0-220) on a router of their own: off, the gate answers document_preview_off.
  const express = (await import("express")).default;
  const filesApp = express(); const filesRouter = express.Router();
  mountFileRoutes(filesRouter, { base: "/r", org: () => null, actor: () => rec.SYSTEM_ACTOR, who: () => ({}) as never, area: (n: string) => rec.findArea(n)! } as never, () => (_q, _s, n) => n());
  filesApp.use("/r", filesRouter);
  const filesServer = filesApp.listen(0, "127.0.0.1"); await new Promise((r) => filesServer.once("listening", r));
  const filesGateOff = async () => { const r = await fetch(`http://127.0.0.1:${(filesServer.address() as { port: number }).port}/r/findings/none/files`); return (await r.json().catch(() => ({}))).code === "document_preview_off"; };
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
  const { agentAppRouter } = await import("../src/agent-routes.js");
  const { pageRoutesOn } = await import("../src/record-page-routes.js");
  const { runnableKinds } = await import("../src/runs.js");
  const { settingGroups } = await import("../src/settings.js");

  // ---------- 1. the registry ----------
  {
    const reg = JSON.parse(readFileSync(path.join(ROOT, "src", "features.json"), "utf8"));
    assert.deepEqual(F.FEATURE_IDS, ["customer_key_vault", "company_email", "scheduled_alerts", "record_clocks", "audit.data", "audit.platform", "audit.sign",
      "onprem_runners", "developer_surface", "declarative_checks", "encrypted_fields", "health_history", "document_preview", "agent_harness", "record_pages", "side_panel_forms",
      // mold_v0-260
      "record_run_inputs", "private_catalogs", "wide_lists", "record_rules", "credential_sets", "overview_cards", "run_analytics", "filters_in_address", "usage_tool"]);
    assert.equal(reg.flags.length, 25);
    for (const f of F.FEATURES) {
      assert.ok(f.short && f.label && f.about && f.off && f.requested_words && f.since, `${f.id}: documented`);
      assert.equal(typeof f.default, "boolean", `${f.id}: a default`);
    }
    // defaults: on for what a pack declared before the registry, off for the opt-in toggles
    const off = F.FEATURES.filter((f) => !f.default).map((f) => f.id);
    assert.deepEqual(off, ["audit.data", "audit.platform", "audit.sign", "onprem_runners", "agent_harness", "record_pages", "side_panel_forms",
      "record_run_inputs", "private_catalogs", "wide_lists", "record_rules", "credential_sets", "overview_cards", "run_analytics", "filters_in_address", "usage_tool"]);
    // mold_v0-260: every one of the batch's flags is quiet while off (the generated files are what they were).
    for (const id of off.slice(7)) assert.equal(F.featureSpec(id).quiet_off, true, `${id}: quiet while off`);
    // the profile's features over the legacy key over the default
    assert.equal(F.featureSetting("audit.data", {}), false);
    assert.equal(F.featureSetting("audit.data", { audit: { data: true } }), true);
    assert.equal(F.featureSetting("audit.data", { audit: { data: true }, features: { "audit.data": false } }), false);
    assert.equal(F.featureSetting("onprem_runners", { onprem_runners: true }), true);
    assert.equal(F.featureSetting("company_email", { features: { company_email: false } }), false);
    assert.equal(F.featureSetting("company_email", {}), true);
    console.log("✓ the registry: 25 flags, each documented with a default; profile.features over the legacy key over the default");
  }

  // ---------- 2. zero packs ----------
  {
    await installEmbedded(null);
    assert.deepEqual(F.featureStates().filter((s) => s.requested).map((s) => s.id), ["audit.data", "audit.platform", "audit.sign", "health_history", "agent_harness", "side_panel_forms", "run_analytics", "filters_in_address", "usage_tool"]);
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
    j.record_areas.find((a: any) => a.name === "findings").fields.push({ name: "evidence", label: "Evidence", type: "file" });
    // mold_v0-253: a record page layout asks for record_pages.
    j.record_areas.find((a: any) => a.name === "findings").detail = { tabs: [{ label: "Overview", sections: [{ title: "Finding", fields: ["severity", "scanner"] }] }] };
  });
  const org = (await createOrg(`Features ${STAMP}`)).org;
  const tools = async () => { const c = await connect(org); try { return (await c.client.listTools()).tools.map((t) => t.name); } finally { await c.close(); } };
  const jobs = () => enabledJobs().map((j) => j.id);

  /** What each capability shows in this build, read from its own gates. */
  const probe = async () => {
    const t = await tools();
    return {
      customer_key_vault: stack(credentialAppRouter()) > 0,
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
      document_preview: F.featureOn("document_preview") && !(await filesGateOff()),
      // The workspace agent (mold_v0-243): its routes, its MCP tools, its claimable kind, its settings and its sweep.
      agent_harness: stack(agentAppRouter()) > 0 && t.includes("start_agent_session") && runnableKinds().some((k) => k.pack === "_agent")
        && settingGroups().some((g) => g.id === "agent") && jobs().includes("harness_sessions"),
      // Record page layouts (mold_v0-253): the console's; mold_v0-254, the page's own route (related lists, runs, actions).
      record_pages: F.featureOn("record_pages") && pageRoutesOn(),
      // Forms in a side panel (mold_v0-256): the console's alone (the profile turns it on).
      side_panel_forms: F.featureOn("side_panel_forms"),
    } as Record<string, boolean>;
  };

  F.setFeaturesForTest(null);
  const defaults = await probe();
  assert.deepEqual(defaults, { customer_key_vault: true, company_email: true, scheduled_alerts: true, record_clocks: true, "audit.data": false, "audit.sign": false, onprem_runners: false,
    developer_surface: true, declarative_checks: true, encrypted_fields: true, health_history: true, document_preview: true, agent_harness: false, record_pages: false, side_panel_forms: false }, "with the defaults: every pack-asked capability on, the toggles off");
  assert.equal(F.featuresOnWords(), "vault, email, alerts, clocks, developer, checks, encrypted, health, documents");
  assert.equal(deliveriesOn(), true);
  console.log(`✓ defaults: on ${F.featuresOnWords()}; audit and runners off (their routes, tools and jobs absent)`);

  // Each flag turned from its default: its own capability flips, every other one stays.
  const turns: [import("../src/features.js").FeatureId, boolean, string][] = [
    ["customer_key_vault", false, "customer_key_vault"],
    ["company_email", false, "company_email"],
    ["scheduled_alerts", false, "scheduled_alerts"],
    ["record_clocks", false, "record_clocks"],
    ["audit.data", true, "audit.data"],
    ["onprem_runners", true, "onprem_runners"],
    ["developer_surface", false, "developer_surface"],
    ["declarative_checks", false, "declarative_checks"],
    ["encrypted_fields", false, "encrypted_fields"],
    ["health_history", false, "health_history"],
    ["document_preview", false, "document_preview"],
    ["agent_harness", true, "agent_harness"],
    ["record_pages", true, "record_pages"],
    ["side_panel_forms", true, "side_panel_forms"],
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

  filesServer.close();
  await installEmbedded(null);

  // ---------- 4. the console, per flag (gen-packs in build copies) ----------
  {
    const TMPC = mkdtempSync(path.join(tmpdir(), "features-console-"));
    const fixture = (j: any) => {
      j.credentials = [{ name: "api_token", label: "API token", bound_to: "workspace", deliver_as: { env: "API_TOKEN" } }];
      j.email = { sender: { allow: true } };
      j.record_areas.find((a: any) => a.name === "tickets").due = { field: "due", within_days: 7 };
      j.record_areas.find((a: any) => a.name === "findings").fields.push({ name: "secret_note", label: "Secret note", type: "text", encrypted: true });
      j.checks = [{ name: "has_ticket", label: "Is there such a ticket?", inputs: { summary: "string" }, rule: { area: "tickets", match: { summary: "$summary" }, latest_by: "updated_at", require: [{ field: "state", ne: "closed" }] } }];
      j.job_kinds[0].private_network = true;
    j.record_areas.find((a: any) => a.name === "findings").fields.push({ name: "evidence", label: "Evidence", type: "file" });
      j.record_areas.find((a: any) => a.name === "findings").detail = { tabs: [{ label: "Overview", sections: [{ title: "Finding", fields: ["severity", "scanner"] }] }] };
    };
    const build = (name: string, features?: Record<string, boolean>) => {
      const copy = path.join(TMPC, name);
      const skip = new Set(["node_modules", ".pglite", ".git", ".next"]);
      cpSync(ROOT, copy, { recursive: true, filter: (src) => !skip.has(path.basename(src)) && src !== path.join(ROOT, "packs") });
      for (const nm of ["node_modules", "web/node_modules"]) if (existsSync(path.join(ROOT, nm))) symlinkSync(path.join(ROOT, nm), path.join(copy, nm), "dir");
      mkdirSync(path.join(copy, "packs", "fixture_embedded"), { recursive: true });
      cpSync(path.join(ROOT, "packs", "pack.schema.json"), path.join(copy, "packs", "pack.schema.json"));
      cpSync(path.join(ROOT, "scripts", "fixtures", "packs", "fixture_embedded"), path.join(copy, "packs", "fixture_embedded"), { recursive: true });
      const f = path.join(copy, "packs", "fixture_embedded", "pack.json");
      const j = JSON.parse(readFileSync(f, "utf8")); fixture(j); writeFileSync(f, JSON.stringify(j, null, 2));
      if (features) writeFileSync(path.join(copy, "profile.json"), JSON.stringify({ features }, null, 2));
      const g = spawnSync(process.execPath, ["scripts/gen-packs.mjs"], { cwd: copy, encoding: "utf8" });
      const read = (rel: string) => (existsSync(path.join(copy, rel)) ? readFileSync(path.join(copy, rel), "utf8") : "");
      const constant = (src: string, name: string) => { const m = new RegExp(`export const ${name}(?::[^=]+?)? = ([\\s\\S]*?)(?: as const)?;\\n`).exec(src); return m ? JSON.parse(m[1]!) : undefined; };
      const nav = read("web/src/config/pack-nav.generated.ts");
      return {
        status: g.status, out: `${g.stdout}\n${g.stderr}`,
        features: constant(read("web/src/config/features.generated.ts"), "features") as Record<string, boolean>,
        tabs: ((constant(nav, "settingsTabs") ?? []) as { id: string }[]).map((t) => t.id),
        workspace: JSON.stringify(constant(nav, "workspacePortalNav") ?? []),
        clocks: ((constant(nav, "recordAreas") ?? []) as { clocks?: unknown[] }[]).some((a) => (a.clocks ?? []).length > 0),
        developer: (constant(nav, "developerConsole") ?? {}).on === true,
        onprem: constant(nav, "onPremRunners") === true,
        alerts: ((constant(nav, "alertRules") ?? []) as unknown[]).length,
        layouts: ((constant(nav, "recordAreas") ?? []) as { detail?: unknown }[]).filter((a) => !!a.detail).length,
      };
    };
    try {
      const base = build("defaults");
      assert.equal(base.status, 0, base.out.slice(-1500));
      assert.deepEqual(Object.entries(base.features).filter(([, v]) => v).map(([k]) => k), ["customer_key_vault", "company_email", "scheduled_alerts", "record_clocks", "developer_surface", "declarative_checks", "encrypted_fields", "health_history", "document_preview"]);
      assert.deepEqual(base.tabs, ["credentials", "api_keys", "allowed_origins", "email", "webhooks", "integrations", "alerts"], "the defaults' Settings tabs, in group order");
      assert.ok(base.workspace.includes("/app/notices") && base.clocks && base.developer && !base.onprem && base.alerts > 0, "Notices, clock columns, the developer tabs; no runners");
      const cases: [string, Record<string, boolean>, (b: ReturnType<typeof build>) => boolean, string][] = [
        ["customer_key_vault", { customer_key_vault: false }, (b) => !b.tabs.includes("credentials"), "no Credentials tab"],
        ["company_email", { company_email: false }, (b) => !b.tabs.includes("email"), "no Email tab"],
        ["scheduled_alerts", { scheduled_alerts: false }, (b) => !b.tabs.includes("alerts") && !b.workspace.includes("/app/notices") && b.alerts === 0 && b.clocks, "no Alerts tab, no Notices entry; the clocks still shown"],
        ["record_clocks", { record_clocks: false }, (b) => !b.clocks && b.tabs.includes("alerts"), "no clock column (the due dates' alerts stay)"],
        ["developer_surface", { developer_surface: false }, (b) => !b.developer && !b.tabs.some((t) => ["api_keys", "allowed_origins", "webhooks", "integrations"].includes(t)), "no API keys, Allowed origins, Webhooks or Integrations tab"],
        ["declarative_checks", { declarative_checks: false }, (b) => b.features.declarative_checks === false, "off in the console's registry"],
        ["health_history", { health_history: false }, (b) => b.features.health_history === false, "off in the console's registry"],
        ["document_preview", { document_preview: false }, (b) => b.features.document_preview === false, "no document card (the console's registry off)"],
        ["record_pages", { record_pages: true }, (b) => b.features.record_pages === true && b.layouts === 1 && base.layouts === 0 && !("record_pages" in base.features), "the findings' page laid out (off: no layout and no flag in the console's files)"],
        ["side_panel_forms", { side_panel_forms: true }, (b) => b.features.side_panel_forms === true && !("side_panel_forms" in base.features), "forms open in a side panel (off: no flag in the console's files)"],
        ["onprem_runners", { onprem_runners: true }, (b) => b.onprem && b.tabs.includes("credentials"), "the runners section on Credentials"],
        ["audit.sign", { "audit.data": true, "audit.sign": true }, (b) => b.tabs.includes("signing") && b.features["audit.data"], "the Signing tab (with the data trail)"],
      ];
      for (const [id, features, check, words] of cases) {
        const b = build(id.replace(".", "-"), features);
        assert.equal(b.status, 0, `${id}: ${b.out.slice(-1500)}`);
        assert.ok(check(b), `${id}: ${words} (${JSON.stringify({ tabs: b.tabs, features: b.features })})`);
        // A quiet_off flag (mold_v0-243, mold_v0-253) is in the console's flags only while on: compare over both builds' keys.
        const changed = [...new Set([...Object.keys(base.features), ...Object.keys(b.features)])].filter((k) => b.features[k] !== base.features[k]);
        assert.deepEqual(changed, Object.keys(features).filter((k) => b.features[k] !== base.features[k]), `${id}: only its own flags change in the console's registry`);
        console.log(`✓ console, ${Object.entries(features).map(([k, v]) => `${k} = ${v}`).join(", ")}: ${words}`);
      }
      const enc = build("encrypted-off", { encrypted_fields: false });
      assert.notEqual(enc.status, 0); assert.match(enc.out, /in the clear/);
      const sign = build("sign-alone", { "audit.sign": true });
      assert.notEqual(sign.status, 0); assert.match(sign.out, /neither audit trail/);
      const conflict = build("conflict", { "audit.data": false });
      assert.equal(conflict.status, 0, "a flag false that is off anyway builds");
      console.log("✓ console: refused at build: encrypted_fields false over an encrypted field (values would be stored in the clear); audit.sign with neither trail");
    } finally { rmSync(TMPC, { recursive: true, force: true }); }
  }
  console.log("FEATURES TEST PASS");
} finally {
  cleanup();
}
process.exit(0);
