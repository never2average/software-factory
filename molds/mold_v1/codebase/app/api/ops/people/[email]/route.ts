import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq, isNull } from "drizzle-orm";
import {
  customers,
  customerStakeholders,
  deployments,
  implementation,
  internalStaff,
  peopleRoster,
  tickets,
  todos,
} from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { DEPLOYMENT_PROFILE, DEFAULT_DOMAINS } from "@/lib/deployment-profile.generated";

/** "deployment" stays "deployment" until the profile renames the area; then it is the area's singular, lower-cased. */
function containerNoun(type: string): string {
  const area = type === "deployment" ? "deployments" : type === "implementation" ? "implementations" : null;
  if (!area) return type;
  const label = DEPLOYMENT_PROFILE.domains[area].label.singular;
  return label === DEFAULT_DOMAINS[area].label.singular ? type : label.toLowerCase();
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/people/:email — a comprehensive dossier for one person, keyed by
 * email (or a name / email-prefix that we resolve). Aggregates identity (staff/
 * stakeholder), org position (roster: team, manager, reportees), the accounts
 * they touch, and everything they OWN across the system-of-record: tickets,
 * deployments, implementations, and assigned/created todos. All the source
 * tables are small, so we read them whole and filter in memory.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ email: string }> }) {
  const octx = await orgContextForRequest(request);
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (octx instanceof Response) return octx;
  const db = getOpsDb();
  const empty = {
    found: false,
    identity: null,
    team: null,
    managerEmail: null,
    chainUp: [],
    reportees: [],
    escalations: [],
    accounts: [],
    tickets: [],
    deployments: [],
    implementations: [],
    todos: [],
  };
  if (!db) return NextResponse.json(empty);

  const raw = decodeURIComponent((await ctx.params).email).trim().toLowerCase();

  try {
    /**
     * All eight reads inside ONE workspace scope.
     *
     * Five of them — staff, stakeholders, tickets, deployments,
     * implementations — carried no org filter at all, so a person page showed
     * every workspace's rows and then filtered in memory by email. Scoping the
     * batch makes the database do the filtering for all eight, including the
     * five that were never going to get a hand-written WHERE.
     */
    const [staff, stakeholders, roster, custs, allTks, allDeps, allImpls, tds] = await withOrgRls(
      octx.orgId,
      (tx) =>
        Promise.all([
      // Every table by the workspace's own org_id. The company-keyed ones used to be read whole and kept when their
      // customer id was one of this workspace's; a company is keyed by (org_id, customer_id) now, and another
      // workspace holding the same id would have passed that filter (mold_v1-118).
      tx.select().from(internalStaff).where(eq(internalStaff.orgId, octx.orgId)),
      tx.select().from(customerStakeholders).where(eq(customerStakeholders.orgId, octx.orgId)),
      tx.select().from(peopleRoster).where(and(eq(peopleRoster.orgId, octx.orgId), isNull(peopleRoster.archivedAt))),
      tx.select({ id: customers.customerId, name: customers.customerName }).from(customers).where(eq(customers.orgId, octx.orgId)),
      tx.select().from(tickets).where(eq(tickets.orgId, octx.orgId)),
      tx.select().from(deployments).where(eq(deployments.orgId, octx.orgId)),
      tx.select().from(implementation).where(eq(implementation.orgId, octx.orgId)),
      tx.select().from(todos).where(and(eq(todos.orgId, octx.orgId), isNull(todos.archivedAt))),
        ]),
    );
    const [tks, deps, impls] = [allTks, allDeps, allImpls];
    const customerName = (id: string | null | undefined) =>
      (id ? custs.find((c) => c.id === id)?.name : null) ?? id ?? null;

    // Resolve the identifier to a canonical email.
    const people = [...staff, ...stakeholders, ...roster];
    let email = raw.includes("@") ? raw : null;
    if (!email) {
      const cand = people.find((r) => {
        const e = (r.email ?? "").toLowerCase();
        const n = ("name" in r ? r.name ?? "" : "").toLowerCase();
        return e === raw || e.split("@")[0] === raw || n === raw;
      });
      email = cand?.email?.toLowerCase() ?? raw;
    }
    const is = (v: string | null | undefined) => (v ?? "").toLowerCase() === email;

    const staffRow = staff.find((r) => is(r.email));
    const stakeRow = stakeholders.find((r) => is(r.email));
    const rosterRow = roster.find((r) => is(r.email));
    const src = staffRow ?? stakeRow;
    const kind = staffRow ? "internal" : stakeRow ? "stakeholder" : "internal";
    const name = src?.name ?? rosterRow?.name ?? email;

    // One entry per account this person is attached to, carrying their ROLE and
    // context (title, last contact) on that account — surfaced on click.
    const acctMap = new Map<
      string,
      { id: string; name: string; role: string | null; title: string | null; lastContact: string | null }
    >();
    const addAcct = (
      customerId: string | null,
      role: string | null,
      title: string | null,
      lastContact: string | null,
    ) => {
      if (!customerId || acctMap.has(customerId)) return;
      acctMap.set(customerId, { id: customerId, name: customerName(customerId) ?? customerId, role, title, lastContact });
    };
    for (const r of staff) if (is(r.email)) addAcct(r.customerId, r.staffRole, r.title, r.lastContact);
    for (const r of stakeholders) if (is(r.email)) addAcct(r.customerId, r.stakeholderRole, r.title, r.lastContact);
    const accounts = [...acctMap.values()];

    // Resolve one person's display fields from whatever tables know them.
    const displayOf = (addr: string) => {
      const e = addr.toLowerCase();
      const rr = roster.find((r) => (r.email ?? "").toLowerCase() === e);
      const sr = staff.find((r) => (r.email ?? "").toLowerCase() === e);
      return { email: addr, name: rr?.name ?? sr?.name ?? addr, title: sr?.title ?? null, role: sr?.staffRole ?? null };
    };

    const managerEmail = rosterRow?.managerEmail ?? null;

    // Walk the manager links upward → the reporting / escalation chain
    // (immediate manager first, up to the top). Guarded against cycles.
    const chainUp: { email: string; name: string; title: string | null; role: string | null }[] = [];
    const seen = new Set<string>([email]);
    let cur = managerEmail;
    while (cur && !seen.has(cur.toLowerCase()) && chainUp.length < 12) {
      chainUp.push(displayOf(cur));
      seen.add(cur.toLowerCase());
      cur = roster.find((r) => (r.email ?? "").toLowerCase() === cur!.toLowerCase())?.managerEmail ?? null;
    }

    const reportees = roster
      .filter((r) => (r.managerEmail ?? "").toLowerCase() === email)
      .map((r) => displayOf(r.email));

    // Escalation contacts: multiple managers, each pinged under a condition.
    // Resolved to display fields for the modal, plus the raw list for editing.
    const escalations = (rosterRow?.escalations ?? []).map((e) => ({
      ...displayOf(e.email),
      reason: e.reason,
    }));

    const ownedTickets = tks
      .filter((t) => is(t.ticketOwnerEmail))
      .map((t) => ({
        id: t.ticketId,
        summary: t.summary,
        status: t.ticketStatus,
        priority: t.ticketPriority,
        customer: t.customerId,
        customerLabel: customerName(t.customerId),
      }));
    const ownedDeployments = deps
      .filter((d) => is(d.deployOwnerEmail))
      .map((d) => ({
        id: d.deploymentId,
        customer: d.customerId,
        customerLabel: customerName(d.customerId),
        env: d.environment,
        version: d.deployedVersion,
        health: d.healthStatus,
        status: d.releaseStatus,
      }));
    const ownedImplementations = impls
      .filter((r) => is(r.implementationOwnerEmail))
      .map((r) => ({
        id: r.rolloutId ?? r.customerId,
        customer: r.customerId,
        customerLabel: customerName(r.customerId),
        stage: r.implementationStage,
        risk: r.implementationRiskLevel,
        progress: r.implementationProgressPct,
      }));
    // A todo's account is inferred from the deployment / implementation it's
    // filed under (todos carry no customer directly), so it can filter too.
    const todoCustomer = (t: (typeof tds)[number]): string | null => {
      if (t.containerType === "deployment" && t.containerId) {
        return deps.find((d) => d.deploymentId === t.containerId)?.customerId ?? null;
      }
      if (t.containerType === "implementation" && t.containerId) {
        return impls.find((r) => (r.rolloutId ?? r.customerId) === t.containerId)?.customerId ?? null;
      }
      return null;
    };
    const ownedTodos = tds
      .filter((t) => is(t.assignee) || is(t.createdBy))
      .map((t) => ({
        id: t.id,
        title: t.title,
        done: t.done,
        priority: t.priority,
        dueAt: t.dueAt?.toISOString() ?? null,
        // The pill a person reads: the container's type as this deployment names it (default: the type itself).
        container: t.containerType ? `${containerNoun(t.containerType)} · ${t.containerLabel ?? t.containerId}` : null,
        customer: todoCustomer(t),
      }));

    return NextResponse.json({
      found: Boolean(staffRow || stakeRow || rosterRow),
      identity: {
        name,
        email,
        title: src?.title ?? null,
        org: src?.employerOrg ?? null,
        role: staffRow?.staffRole ?? stakeRow?.stakeholderRole ?? null,
        kind,
        lastContact: src?.lastContact ?? null,
      },
      team: rosterRow?.team ?? null,
      // The raw links, so the modal's pickers show/edit current values.
      managerEmail,
      chainUp,
      reportees,
      escalations,
      accounts,
      tickets: ownedTickets,
      deployments: ownedDeployments,
      implementations: ownedImplementations,
      todos: ownedTodos,
    });
  } catch (e) {
    return NextResponse.json({ ...empty, error: errorText(e) }, { status: 500 });
  }
}
