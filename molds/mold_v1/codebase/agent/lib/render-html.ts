/**
 * Deterministic, self-contained HTML report renderers over the system-of-record
 * READ surface.
 *
 * PURE + clock-injected. Every exported renderer takes an explicit `now` (ISO
 * string or Date) and never reads the wall clock, so its output is a pure
 * function of (store state, now) — testable offline against the bundled seed
 * JSON (no Postgres required; see scripts/test-render.mjs).
 *
 * Output contract: each renderer returns a COMPLETE, standalone HTML document
 * (`<!doctype html>` … `</html>`) with INLINE CSS only, zero external assets,
 * and NO `<script>` — safe to publish as a private signed-link artifact or open
 * directly in a browser. Light/dark theming is handled purely with a
 * `prefers-color-scheme` media query and a system font stack. Every interpolated
 * data value is routed through `escapeHtml` (exported for the injection test).
 *
 * Keep the relative `.ts` import specifiers below: plain
 * `node --experimental-strip-types` does not resolve the `#lib/*.js` subpath
 * aliases the offline test relies on.
 */
import { getCustomer, listCustomers, listFollowUps } from "./system-of-record.ts";
import { computeStandupDigest, type FollowUpAlert } from "./alerts.ts";
import type { Customer } from "./customer-schema.ts";

/* -------------------------------------------------------------------------- */
/* Escaping + small HTML primitives                                           */
/* -------------------------------------------------------------------------- */

/** Escape the five HTML-significant characters. Exported for the injection test. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render an arbitrary cell value as escaped text; blanks render as an em dash. */
function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "<span class=\"muted\">—</span>";
  if (Array.isArray(value)) {
    return value.length ? escapeHtml(value.join(", ")) : "<span class=\"muted\">—</span>";
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  return escapeHtml(String(value));
}

function utcDate(now: Date | string): string {
  return new Date(now instanceof Date ? now.getTime() : new Date(now).getTime())
    .toISOString()
    .slice(0, 10);
}

function dayOf(value: string): string {
  return value.slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Shared document shell + CSS                                                 */
/* -------------------------------------------------------------------------- */

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1.25rem 4rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  color: #1a1a2e;
  background: #f6f7f9;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 960px; margin: 0 auto; }
header.report {
  padding: 1.5rem 1.5rem 1.25rem;
  border-radius: 14px;
  background: #ffffff;
  border: 1px solid #e3e6ea;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
h1 { font-size: 1.6rem; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
h2 { font-size: 1.15rem; margin: 2rem 0 0.75rem; letter-spacing: -0.01em; }
.sub { color: #667085; font-size: 0.9rem; margin: 0; }
.meta { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; margin-top: 1rem; }
.meta div { font-size: 0.9rem; }
.meta .k { color: #667085; display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
.meta .v { font-weight: 600; }
section {
  background: #ffffff;
  border: 1px solid #e3e6ea;
  border-radius: 14px;
  padding: 1rem 1.25rem 1.25rem;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
}
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #eceef1; vertical-align: top; }
th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: #667085; font-weight: 600; }
tbody tr:last-child td { border-bottom: none; }
.muted { color: #98a2b3; }
.pill {
  display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px;
  font-size: 0.72rem; font-weight: 600; border: 1px solid transparent;
}
.pill.overdue { background: #fde8e8; color: #b42318; border-color: #f4c7c3; }
.pill.due_soon { background: #fef3d7; color: #b54708; border-color: #f2d79b; }
.pill.on_track { background: #e6f4ea; color: #067647; border-color: #b9e3c6; }
.pill.no_due_date { background: #eef1f4; color: #475467; border-color: #dfe3e8; }
.totals { margin-top: 0.75rem; color: #475467; font-size: 0.9rem; }
.empty { color: #98a2b3; font-style: italic; font-size: 0.9rem; }
footer { margin-top: 2rem; text-align: center; color: #98a2b3; font-size: 0.78rem; }
@media (prefers-color-scheme: dark) {
  body { color: #e4e7ec; background: #101114; }
  header.report, section { background: #17191d; border-color: #2a2d33; box-shadow: none; }
  .sub, .meta .k, th { color: #98a2b3; }
  th, td { border-bottom-color: #23262b; }
  .muted { color: #667085; }
  .pill.overdue { background: #3a1614; color: #fda29b; border-color: #5a201c; }
  .pill.due_soon { background: #3a2a10; color: #fdb022; border-color: #5a3f18; }
  .pill.on_track { background: #10301e; color: #75e0a7; border-color: #1a4630; }
  .pill.no_due_date { background: #23262b; color: #98a2b3; border-color: #33373d; }
  .totals { color: #98a2b3; }
}
`.trim();

function documentShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

function metaItem(label: string, value: unknown): string {
  return `<div><span class="k">${escapeHtml(label)}</span><span class="v">${cell(value)}</span></div>`;
}

/* -------------------------------------------------------------------------- */
/* Account report                                                             */
/* -------------------------------------------------------------------------- */

function urgencyLabel(a: FollowUpAlert): string {
  if (a.urgency === "overdue") {
    const n = a.daysUntilDue === null ? "" : `${Math.abs(a.daysUntilDue)}d overdue`;
    return n || "overdue";
  }
  if (a.urgency === "due_soon") {
    return a.daysUntilDue === null ? "due soon" : a.daysUntilDue <= 0 ? "due today" : `in ${a.daysUntilDue}d`;
  }
  if (a.urgency === "no_due_date") return "no due date";
  return a.daysUntilDue === null ? "on track" : `in ${a.daysUntilDue}d`;
}

function followUpsSection(alerts: FollowUpAlert[]): string {
  if (alerts.length === 0) {
    return `<section><h2>Open Follow-Ups</h2><p class="empty">No open follow-ups.</p></section>`;
  }
  const rows = alerts
    .map(
      (a) => `<tr>
<td>${escapeHtml(a.ticketId)}</td>
<td>${escapeHtml(a.summary)}</td>
<td>${cell(a.ticketPriority)}</td>
<td><span class="pill ${a.urgency}">${escapeHtml(urgencyLabel(a))}</span>${
        a.dueAt ? ` <span class="muted">${escapeHtml(dayOf(a.dueAt))}</span>` : ""
      }</td>
<td>${escapeHtml(a.nextStep)}</td>
</tr>`,
    )
    .join("\n");
  return `<section>
<h2>Open Follow-Ups</h2>
<div class="tablewrap">
<table>
<thead><tr><th>Ticket</th><th>Summary</th><th>Priority</th><th>Urgency / Due</th><th>Next Step</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</section>`;
}

function interactionsSection(customer: Customer): string {
  const interactions = [...(customer.interactions ?? [])].sort((a, b) =>
    String(b.interactionAt).localeCompare(String(a.interactionAt)),
  );
  if (interactions.length === 0) {
    return `<section><h2>Recent Interactions</h2><p class="empty">No interactions on record.</p></section>`;
  }
  const rows = interactions
    .map(
      (i) => `<tr>
<td>${escapeHtml(dayOf(i.interactionAt))}</td>
<td>${cell(i.interactionType)}</td>
<td>${cell(i.summary ?? i.note)}</td>
<td>${cell(i.sentiment)}</td>
</tr>`,
    )
    .join("\n");
  return `<section>
<h2>Recent Interactions</h2>
<div class="tablewrap">
<table>
<thead><tr><th>Day</th><th>Type</th><th>Summary</th><th>Sentiment</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</section>`;
}

function deploymentsSection(customer: Customer): string {
  const deployments = customer.deployments ?? [];
  if (deployments.length === 0) {
    return `<section><h2>Deployments</h2><p class="empty">No deployments on record.</p></section>`;
  }
  const rows = deployments
    .map(
      (d) => `<tr>
<td>${escapeHtml(d.deploymentId)}</td>
<td>${cell(d.environment)}</td>
<td>${cell(d.deployedVersion)}</td>
<td>${cell(d.releaseStatus)}</td>
<td>${cell(d.healthStatus)}</td>
</tr>`,
    )
    .join("\n");
  return `<section>
<h2>Deployments</h2>
<div class="tablewrap">
<table>
<thead><tr><th>Deployment</th><th>Environment</th><th>Version</th><th>Release Status</th><th>Health</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</section>`;
}

function platformSection(customer: Customer): string {
  const p = customer.platform;
  if (!p) {
    return `<section><h2>Platform Summary</h2><p class="empty">No platform record.</p></section>`;
  }
  return `<section>
<h2>Platform Summary</h2>
<div class="meta">
${metaItem("Deployment Model", p.deploymentModel)}
${metaItem("Data Residency", p.dataResidencyConstraint)}
${metaItem("Primary Model", p.primaryModel)}
${metaItem("Governance Status", p.aiGovernanceStatus)}
${metaItem("Primary Use Case", p.primaryUseCase)}
${metaItem("Connectors", p.enabledConnectors)}
</div>
</section>`;
}

/**
 * Render a deterministic, self-contained HTML account report for one customer.
 * Throws `Unknown customer: ${customerId}` when the customer is absent.
 */
export async function renderAccountReport(opts: {
  customerId: string;
  now: Date | string;
}): Promise<string> {
  const customer = await getCustomer(opts.customerId);
  if (!customer) throw new Error(`Unknown customer: ${opts.customerId}`);

  // Reuse the alerts ranking (overdue-first) scoped to this customer.
  const digest = await computeStandupDigest({ now: opts.now, topPerCustomer: 1000 });
  const section = digest.sections.find((s) => s.customerId === opts.customerId);
  const alerts = section ? section.topFollowUps : [];

  const header = `<header class="report">
<h1>${escapeHtml(customer.name)}</h1>
<p class="sub">Account report · Generated ${escapeHtml(utcDate(opts.now))} (UTC)</p>
<div class="meta">
${metaItem("Tier", customer.tier)}
${metaItem("Lifecycle Stage", customer.lifecycleStage)}
${metaItem("Status", customer.status)}
${metaItem("Health Score", customer.healthScore)}
${metaItem("FDE Owner", customer.fdeOwner)}
</div>
</header>`;

  const body = [
    header,
    followUpsSection(alerts),
    interactionsSection(customer),
    deploymentsSection(customer),
    platformSection(customer),
    `<footer>Deterministic report from the system of record · ${escapeHtml(
      escapeHtml(customer.id),
    )}</footer>`,
  ].join("\n");

  return documentShell(`${customer.name} — Account Report`, body);
}

/* -------------------------------------------------------------------------- */
/* Data-room summary (all customers)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Render a deterministic, self-contained HTML index across all customers:
 * name, tier, lifecycle, status, FDE owner, open-ticket count, and overdue
 * count (from the alerts engine), plus a totals line.
 */
export async function renderDataroomSummary(opts: { now: Date | string }): Promise<string> {
  const [customers, digest, followUps] = await Promise.all([
    listCustomers(),
    computeStandupDigest({ now: opts.now }),
    listFollowUps(),
  ]);
  const overdueByCustomer = new Map<string, number>();
  for (const s of digest.sections) overdueByCustomer.set(s.customerId, s.overdueCount);

  const rows = customers
    .map(
      (c) => `<tr>
<td>${escapeHtml(c.name)}</td>
<td>${cell(c.tier)}</td>
<td>${cell(c.lifecycleStage)}</td>
<td>${cell(c.status)}</td>
<td>${cell(c.fdeOwner)}</td>
<td>${c.openTickets}</td>
<td>${overdueByCustomer.get(c.id) ?? 0}</td>
</tr>`,
    )
    .join("\n");

  const header = `<header class="report">
<h1>Data Room Summary</h1>
<p class="sub">All customers · Generated ${escapeHtml(utcDate(opts.now))} (UTC)</p>
</header>`;

  const table = `<section>
<h2>Customers</h2>
<div class="tablewrap">
<table>
<thead><tr><th>Customer</th><th>Tier</th><th>Lifecycle</th><th>Status</th><th>FDE Owner</th><th>Open Tickets</th><th>Overdue</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
<p class="totals">${customers.length} customers · ${followUps.length} open follow-ups · ${
    digest.totals.overdue
  } overdue · ${digest.totals.dueSoon} due soon.</p>
</section>`;

  const body = [header, table, `<footer>Deterministic summary from the system of record</footer>`].join(
    "\n",
  );

  return documentShell("Data Room Summary", body);
}
