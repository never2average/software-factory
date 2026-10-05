/**
 * What a person SEES: the visible text of every page and tab of a built copy, read from the rendered DOM.
 *
 * `next start` serves the build; Chromium (Playwright) opens each page signed in with a locally made email-session
 * token (never verified: every /api/ call is answered here, from MOCKS, so no secret, database or agent is needed)
 * and reads `document.body.innerText`, the visible attributes (title, placeholder, aria-label, alt), <option>s, and
 * the tooltips that appear when a row's icon is hovered. Adopted from the PR #60 reviewer's harness, which found the
 * leaks the static and bundle passes had excused: text assembled at runtime from code values ("filed under a
 * deployment/implementation"), a record's entity rendered into a sentence ("Governs implementations"), and
 * directory names in a chip ("needs customer-context").
 *
 *   renderedText({ dir, root, pages?, port? }) -> [{ page, text }]   one entry per distinct visible line
 *
 * The mocked records carry no base word of their own (user data is never the check's business), except where a
 * record's CODE value is the point: a workflow's `entity`, an edited workflow's `needsExcluded`.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { freePort, waitForNextStart } from "./own-listener.mjs";
import { BASE_PRODUCT_WORD } from "./agent-cli.mjs";

/**
 * Every page and tab, each with the text (or CSS selector, `css:`) that proves it RENDERED — a page that shows the
 * error screen, throws, or never shows its marker fails the pass instead of passing as an empty page — and the
 * interactions that reach what a first paint does not show: a record's detail panel, a "New …" dialog.
 * An interaction is `{ click, expect }`: click the first element with that visible text, then wait for `expect`.
 */
export const PAGE_SPECS = [
  { path: "/", ready: "css:textarea" },
  { path: "/?ops=workflows", ready: "Specialist subagents the orchestrator delegates to", then: [{ click: "Add Workflow", expect: "How should this workflow start?" }] },
  { path: "/?ops=crons", ready: "Scheduled jobs that run the agent on a cadence", then: [{ click: "Add Schedule", expect: "How often should it run?" }] },
  { path: "/?ops=apps", ready: "Living documents the agent regenerates", then: [{ click: "Add App", expect: "Create app" }] },
  { path: "/?ops=inbox", ready: "Off-platform conversations", then: [{ click: "Q2 results call", expect: "Copy context" }] },
  { path: "/?ops=connectors", ready: "Ingestion sources feeding the data room" },
  { path: "/?ops=todos&view=tasks", ready: "The team's internal action list", then: [{ click: "Chase the Q2 filing", expect: "Properties" }] },
  { path: "/?ops=todos&view=deployments", ready: "The team's internal action list", then: [{ click: "Acme Housing", expect: "Properties" }] },
  { path: "/?ops=todos&view=implementations", ready: "The team's internal action list" },
  { path: "/?ops=todos&view=sprints", ready: "The team's internal action list" },
  { path: "/?dataroom=customers", ready: "Master.xlsx" },
  { path: "/?dataroom=platform", ready: "Master.xlsx" },
  { path: "/?dataroom=deployments", ready: "Master.xlsx" },
  { path: "/?dataroom=implementation", ready: "Master.xlsx" },
  { path: "/?dataroom=people", ready: "Master.xlsx" },
  { path: "/?dataroom=tickets", ready: "Master.xlsx" },
  { path: "/workspace", ready: "Every document, dataset, and artifact the agent works from." },
  { path: "/workspace?tab=agents", ready: "The specialist subagents the orchestrator delegates to" },
  { path: "/workspace?tab=workflows", ready: "Define the stages work moves through", then: [{ click: "New workflow", expect: "Choose what kind of work this workflow governs." }] },
  { path: "/workspace?tab=people", ready: "Everyone in this workspace" },
  { path: "/workspace?tab=connectors", ready: "Ingestion sources feeding the data room" },
  { path: "/workspace?tab=audit", ready: "Every change made in this workspace" },
  { path: "/workspace?tab=dataroom", ready: "Every document, dataset, and artifact the agent works from." },
  { path: "/onboard", ready: "css:body" },
  // The states a workspace sees before (or without) records, in the profile's words: the data room and the chat's
  // account picker with no records, while they load, and when they could not be read.
  { name: "data room, empty workspace", path: "/?dataroom=customers", ready: "css:[data-testid=dataroom-empty]", mocks: { "/api/ops/workbook": { customers: [], people: { internalStaffAssignments: [], customerStakeholders: [] } } } },
  { name: "data room, loading", path: "/?dataroom=customers", ready: "css:[data-testid=dataroom-loading]", mocks: { "/api/ops/workbook": { $delayMs: 8000, $body: {} } } },
  { name: "data room, could not be read", path: "/?dataroom=customers", ready: "css:[data-testid=dataroom-error]", mocks: { "/api/ops/workbook": { $status: 503, $body: { error: "unavailable" } } } },
  { name: "data room, one table could not be read", path: "/?dataroom=deployments", ready: "css:[data-testid=dataroom-unavailable]", mocks: { "/api/ops/workbook": { customers: [{ id: "acme", name: "Acme Housing" }], people: {}, unavailable: ["deployments"] } } },
  { name: "account picker, empty workspace", path: "/", ready: "css:textarea", mocks: { "/api/ops/customers": { customers: [], items: [] } }, then: [{ click: "css:[data-testid=account-picker]", expect: "css:[data-testid=account-picker-empty]" }] },
  { name: "account picker, loading", path: "/", ready: "css:textarea", mocks: { "/api/ops/customers": { $delayMs: 8000, $body: { customers: [] } } }, then: [{ click: "css:[data-testid=account-picker]", expect: "css:[data-testid=account-picker-loading]" }] },
  { name: "account picker, could not be read", path: "/", ready: "css:textarea", mocks: { "/api/ops/customers": { $status: 503, $body: { error: "unavailable" } } }, then: [{ click: "css:[data-testid=account-picker]", expect: "css:[data-testid=account-picker-error]" }] },
];
export const PAGES = PAGE_SPECS.map((p) => p.path);

/** What the app shows when a page crashed. Seeing it fails the pass. A region's own boundary ("The Ops Center hit an
 *  error", app/_components/error-boundary.tsx; "This page hit an error", app/error.tsx) is a crash too: the panel
 *  that should have been read is not there. */
const ERROR_SCREENS = [/This page couldn.t load/i, /Application error/i, /Unhandled Runtime Error/i, /Something went wrong/i, /\bhit an error\b/i];

/**
 * The fields a profile can hide in the data room, by where they live (BASE keys): the account's scalar fields, and the
 * two redefinable areas' fields. The mock gives each a marked value (`HIDDEN-FIELD-<key>`), so the rendered pass can
 * tell a hidden field that leaked from one that was dropped.
 */
export const HIDEABLE = {
  account: ["aeOwner", "arr", "arrCurrency", "seats", "accountRegion", "contractStatus", "renewalForecast", "renewalRiskReason", "expansionPotentialArr", "valueRealizationStage", "targetAnnualValue", "realizedAnnualValue", "successCriteria", "valuePeriodStart", "valuePeriodEnd", "valueEvidenceStatus", "valueEvidenceUrl", "lastBusinessReviewDate", "nextBusinessReviewDate", "contractStart", "renewalDate", "technicalOwnerEmail", "executiveSponsorEmail"],
  deployments: ["region", "environment", "cloudProvider", "deploymentStrategy", "buildSha", "uptime30dPct", "errorRate30dPct", "latencyP95Ms", "cost30dUsd", "rollbackVersion", "dashboardUrl", "runbookUrl"],
  implementation: ["securityReviewStatus", "privacyReviewStatus", "billingReadinessStatus", "runbookStatus", "supportOwnerEmail", "launchDecision"],
};
export const HIDDEN_MARK = "HIDDEN-FIELD-";
const hiddenMarks = (keys) => Object.fromEntries(keys.map((k) => [k, `${HIDDEN_MARK}${k}`]));

const now = () => new Date().toISOString();
const at = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
/** The ops API as the pages ask for it: one filled record per list, so a list, its row and its detail render. Record
 *  TEXT is neutral data; the CODE values (containerType, entity, a stored enum value) are the base product's, which is
 *  the point. Anything not listed answers `{ items: [] }`. */
export const MOCKS = () => ({
  "/api/ops/customers": { customers: [{ id: "acme", name: "Acme Housing" }], items: [{ id: "acme", name: "Acme Housing" }] },
  "/api/ops/workflows": {
    items: [
      // Written here, delegating to two specialists this deployment excludes: the chip must count them, not name them.
      { id: "11111111-1111-4111-8111-111111111111", name: "my-brief", description: "A brief written here", trigger: "manual", steps: [], script: "await agent('x', { subagent: 'customer-context' })", instructions: null, notifyEmail: null, notifyEmails: null, enabled: true, customerId: null, createdBy: "reviewer@example.com", createdAt: now(), updatedAt: now(), availability: { available: true, needsExcluded: ["customer-context", "deployment"] } },
      // A base library row this deployment does not run: listed, adoptable, and its reason names no specialist.
      { id: "22222222-2222-4222-8222-222222222222", name: "assign-account", description: "Propose and set the owner for a new account.", trigger: "manual", steps: [], script: "", instructions: null, notifyEmail: null, notifyEmails: null, enabled: true, customerId: null, createdBy: "system", createdAt: now(), updatedAt: now(), availability: { available: false, reason: "Part of the base workflow library, which does not apply to this workspace: it delegates to a specialist this workspace does not use. Edit it to use this workspace's specialists and it becomes yours to run.", needsExcluded: ["customer-context"] } },
    ],
    libraryNote: "4 of the 13 library workflows are not part of this workspace: each delegates to a specialist it does not use. Add your own with “New workflow”.",
  },
  // A project workflow governing the implementation record area: its entity is a CODE value the UI must name in the profile's words.
  "/api/ops/workflow-definitions": { items: [{ id: "d1", name: "Pipeline", entity: "implementation", stages: [{ id: "s1", name: "Scoping", description: "x", assign: { type: "customer_owner" }, transitions: [] }], createdBy: "reviewer@example.com" }], canEdit: true },
  "/api/ops/todos": { items: [{ id: "t1", title: "Chase the Q2 filing", notes: null, done: false, doneAt: null, status: "open", priority: "normal", dueAt: null, containerType: "deployment", containerId: "d1", containerLabel: "Q2 results", linkType: "customer", linkId: "acme", linkLabel: "Acme Housing", cycleId: null, parentId: null, createdBy: "reviewer@example.com", assignee: null, archivedAt: null, createdAt: at(2), updatedAt: at(1) }] },
  "/api/ops/deployments": { items: [{ id: "d1", label: "Q2 results", displayName: null, owner: "reviewer@example.com", status: "deployed", health: "healthy", env: "prod", version: "1", customer: "acme", customerLabel: "Acme Housing", uptime: null, errorRate: null, lastDeployAt: at(3), fields: {}, custom: {} }] },
  "/api/ops/implementations": { items: [{ id: "acme", label: "Acme Housing", displayName: null, owner: "reviewer@example.com", stage: "UAT", risk: "low", progress: 40, customer: "acme", customerLabel: "Acme Housing", solutionName: null, goLiveDate: null, fields: { blockerOwner: "Customer" }, custom: {} }] },
  "/api/ops/schedules": { items: [{ id: "s1", name: "daily-digest", cron: "0 9 * * *", everyMinutes: null, kind: "prompt", workflow: null, prompt: "Summarise yesterday's filings", channelId: null, customerId: null, notifyEmail: null, notifyEmails: null, enabled: true, nextRunAt: null, lastRunAt: null, lastError: null, createdBy: "reviewer@example.com", createdAt: at(5), updatedAt: at(5) }] },
  "/api/ops/apps": { items: [{ id: "a1", slug: "coverage-digest", name: "Coverage digest", description: "A weekly digest", sourceKind: "prompt", workflow: null, prompt: "Write the digest", subagent: null, customerId: null, refreshCron: null, contentMd: "# Digest\n\nAll quiet.", contentUpdatedAt: at(1), lastRunId: null, lastSessionId: null, lastError: null, lastRefreshAt: at(1), enabled: true, createdBy: "reviewer@example.com", createdAt: at(4), updatedAt: at(1) }] },
  "/api/ops/inbox": { threads: [{ threadKey: "k1", source: "email", subject: "Q2 results call", preview: "Notes from the call", participants: ["ir@acme.example"], customerId: null, messageCount: 1, unread: true, firstAt: at(1), lastAt: at(1), messages: [{ id: "m1", from: "ir@acme.example", preview: "Notes from the call", body: "Notes from the call", occurredAt: at(1) }] }] },
  "/api/dataroom": { paths: [] },
  // The workspace's own records, which every Master.xlsx preview is built from (the client bundles none). Every field a
  // profile may HIDE carries a value marked HIDDEN-FIELD-<key>: the data room must drop it even when an answer carries
  // it, and check-ui-vocabulary fails on any marker (or the column) of a field the rendered profile hides. The own
  // (custom) fields are those a profile may declare; the ones it lists show as columns in its labels.
  "/api/ops/workbook": {
    customers: [{
      id: "acme", name: "Acme Housing", tier: "Enterprise", status: "On Track", lifecycleStage: "Live", fdeOwner: "reviewer@example.com",
      ...hiddenMarks(HIDEABLE.account),
      custom: { house_view: "Positive", notes: "Filings read through Q2." },
      platform: { tenantId: "t1" }, solutions: [],
      deployments: [{ deploymentId: "d1", deployedVersion: "Q2 FY26", releaseStatus: "deployed", lastDeployAt: at(3), ...hiddenMarks(HIDEABLE.deployments), custom: { rating: "Buy", target_price: 1234, kpi_completeness: 80, aum_cr: 5000 } }],
      implementation: { rolloutId: "r1", implementationStage: "UAT", ...hiddenMarks(HIDEABLE.implementation), custom: { coverage_priority: "Core", next_review: "2026-10-01" } },
      tickets: [{ ticketId: "T-1", summary: "Chase the Q2 filing", ticketStatus: "Open", ticketPriority: "P2-Medium" }],
      interactions: [{ interactionId: "i1", interactionAt: at(2), interactionType: "call", summary: "Q2 results call" }],
    }],
    people: {
      internalStaffAssignments: [{ customer_id: "acme", staffRole: "solution_engineer", name: "Reviewer", title: "Analyst", employerOrg: "Research", email: "reviewer@example.com" }],
      customerStakeholders: [{ customer_id: "acme", stakeholderRole: "champion", name: "Ira Mehta", title: "Head of Investor Relations", employerOrg: "Acme Housing", email: "ir@acme.example" }],
    },
  },
  "/api/ops/me/workspaces": { memberships: [{ orgId: "o1", name: "Research", orgName: "Research", role: "owner", slug: "research" }], invites: [], active: "o1" },
  "/api/ops/orgs": { items: [{ orgId: "o1", id: "o1", name: "Research", branding: {} }] },
  "/api/ops/summary": { total: 0, sections: [] },
  "/api/ops/chat-sessions": { sessions: [], items: [] },
  "/api/ops/threads": { threads: [], items: [] },
});

const BASE = new Set(["customer", "customers", "deployment", "deployments", "implementation", "implementations", "rollout", "rollouts", BASE_PRODUCT_WORD, `${BASE_PRODUCT_WORD}s`]);
export function baseWordsIn(t) {
  const f = [];
  for (const m of t.matchAll(/[A-Za-z0-9]+/g)) for (const p of m[0].split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) if (BASE.has(p.toLowerCase())) f.push(p);
  if (/forward[\s-]deployed/i.test(t)) f.push("forward-deployed");
  return f;
}

/**
 * The canary: the inbox answered with no `threads` crashes to the error screen. The pass must report it; a pass that
 * reads a crashed page as rendered (as the first version did, on every page) is not reading anything.
 */
export const CANARY = { path: "/?ops=inbox", ready: "Off-platform conversations", mocks: { "/api/ops/inbox": {} }, canary: true };

/** Render `specs`; returns every visible line and, per page that could not be read, why. */
export async function renderedText({ dir, root, specs = PAGE_SPECS }) {
  const require = createRequire(join(root, "package.json"));
  let chromium;
  try { ({ chromium } = require("@playwright/test")); } catch { throw new Error("@playwright/test is not installed (npm ci)"); }
  const port = await freePort();
  const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) } });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  let browser;
  try {
    await waitForNextStart({ server, port, log: () => log });
    try { browser = await chromium.launch(); } catch (e) {
      throw new Error(`Chromium is not installed for Playwright; run \`npx playwright install chromium\` (CI: --with-deps). ${String(e.message ?? e).split("\n")[0]}`);
    }
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64({ alg: "none" })}.${b64({ email: "reviewer@example.com", name: "Reviewer", kind: "email-session", exp: Math.floor(Date.now() / 1000) + 7200 })}.x`;
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addInitScript((t) => { localStorage.setItem("workspace-google-token", t); }, jwt);
    const base_mocks = MOCKS();
    let mocks = base_mocks;
    await ctx.route(/\/api\//, async (route) => {
      const u = new URL(route.request().url());
      const answer = mocks[u.pathname] ?? { items: [], ok: true };
      // `{ $status, $body, $delayMs }` answers with that status, after that delay: a failed read, a slow one.
      const shaped = answer && typeof answer === "object" && ("$status" in answer || "$delayMs" in answer);
      if (shaped && answer.$delayMs) await new Promise((r) => setTimeout(r, answer.$delayMs));
      await route.fulfill({ status: shaped ? (answer.$status ?? 200) : 200, contentType: "application/json", body: JSON.stringify(shaped ? (answer.$body ?? {}) : answer) }).catch(() => {});
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(10_000);
    const out = [];
    const failures = [];
    let pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e).split("\n")[0]));
    // The first VISIBLE match: a list's text may also sit in a closed menu or a hidden <option>.
    const locate = (m) => (m.startsWith("css:") ? page.locator(m.slice(4)) : page.getByText(m, { exact: false })).filter({ visible: true }).first();
    for (const spec of specs) {
      const p = spec.path;
      mocks = spec.mocks ? { ...base_mocks, ...spec.mocks } : base_mocks;
      const started = Date.now();
      pageErrors = [];
      const seen = new Set();
      const add = (t) => { for (const l of String(t ?? "").split("\n")) { const x = l.trim(); if (x && !seen.has(x)) { seen.add(x); if (!spec.canary) out.push({ page: p, ...(spec.name ? { name: spec.name } : {}), text: x }); } } };
      const read = async () => {
        const texts = await page.evaluate(() => {
          const o = [document.body.innerText];
          for (const el of document.querySelectorAll("[title],[placeholder],[aria-label],[alt]")) for (const a of ["title", "placeholder", "aria-label", "alt"]) { const v = el.getAttribute(a); if (v) o.push(v); }
          for (const opt of document.querySelectorAll("option")) o.push(opt.textContent);
          return o;
        });
        for (const t of texts) add(t);
      };
      try {
        const res = await page.goto(base + p, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (!res || res.status() >= 400) throw new Error(`HTTP ${res?.status() ?? "no response"}`);
        // Rendered = its marker is visible. No network-idle wait: every API answer is local and immediate.
        await locate(spec.ready).waitFor({ state: "visible", timeout: 20_000 });
        await page.waitForTimeout(400);
        // Tooltips shown on hover: a workflow's entity icon, a chip.
        for (const h of (await page.$$("span.grid.size-7")).slice(0, 6)) {
          await h.hover({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(250);
          for (const t of await page.$$eval("[role=tooltip]", (els) => els.map((e) => e.textContent))) add(t);
        }
        await read();
        for (const step of spec.then ?? []) {
          // `mocks`: what the API answers from this step on (a list that failed, then loads on Retry).
          if (step.mocks) mocks = { ...mocks, ...step.mocks };
          await locate(step.click).click({ timeout: 10_000 });
          await locate(step.expect).waitFor({ state: "visible", timeout: 10_000 });
          await page.waitForTimeout(300);
          await read();
          // `keepOpen`: the next step clicks inside what this one opened.
          if (!step.keepOpen) await page.keyboard.press("Escape").catch(() => {});
        }
      } catch (e) {
        failures.push({ spec, why: `did not render (${String(e?.message ?? e).split("\n")[0]})` });
      }
      const body = await page.evaluate(() => document.body.innerText).catch(() => "");
      const screen = ERROR_SCREENS.find((re) => re.test(body));
      if (screen) failures.push({ spec, why: `shows the error screen (${screen})` });
      if (pageErrors.length) failures.push({ spec, why: `page error — ${pageErrors[0]}` });
      if (process.env.UI_VOCABULARY_TIMING) console.error(`rendered ${p}: ${Date.now() - started} ms`);
    }
    return { lines: out, failures: failures.map((f) => ({ page: f.spec.path, ...(f.spec.name ? { name: f.spec.name } : {}), canary: f.spec.canary === true, why: f.why })) };
  } finally {
    await browser?.close().catch(() => {});
    server.kill("SIGTERM");
  }
}
