import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import {
  deployments,
  implementation,
  inboxItems,
  tickets,
  todos,
  workflowRuns,
} from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { W } from "@/lib/ui-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/summary — what needs attention IN THIS WORKSPACE, in one call.
 *
 * The signals existed but were scattered across six panels, so "what changed
 * while I was away" meant opening all six and remembering the previous numbers.
 * Worse for anyone in two workspaces: nothing anywhere said which workspace a
 * count belonged to, so the answer to "is this urgent" depended on a selection
 * you could not see.
 *
 * Every query is filtered by org, and the response NAMES the workspace it
 * counted. A summary that does not say whose it is, is the bug it is meant to
 * fix.
 *
 * Counts come back with a sample of the actual rows: "4 overdue" is a number,
 * "4 overdue, the oldest being X" is something you can act on.
 */

const OPEN_TICKETS = ["Open", "In Progress", "Needs Triage", "Reopened", "Blocked"];
const URGENT = ["P0-Critical", "P1-High"];

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const org = ctx.orgId;
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  /**
   * Each section is independent and best-effort. One missing table must not
   * blank the whole summary — a partial answer is useful, a 500 is not.
   */
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  /**
   * One workspace scope for all six queries.
   *
   * They already filter on org_id by hand; this puts the database behind that,
   * so a filter someone forgets to add later returns nothing instead of
   * another tenant's rows. One transaction rather than six — the GUC is
   * transaction-local, so each would otherwise need its own.
   */
  const [triage, urgentTickets, overdueTodos, unhealthy, atRisk, failedRuns] = await withOrgRls(org, (tx) =>
    Promise.all([
    safe(
      () =>
        tx
          .select({ id: inboxItems.id, subject: inboxItems.subject, at: inboxItems.occurredAt })
          .from(inboxItems)
          .where(and(eq(inboxItems.orgId, org), eq(inboxItems.status, "new")))
          .orderBy(desc(inboxItems.occurredAt))
          .limit(50),
      [] as { id: string; subject: string | null; at: Date | null }[],
    ),
    safe(
      () =>
        tx
          .select({
            id: tickets.ticketId,
            customerId: tickets.customerId,
            summary: tickets.summary,
            priority: tickets.ticketPriority,
          })
          .from(tickets)
          .where(
            and(
              eq(tickets.orgId, org),
              inArray(tickets.ticketStatus, OPEN_TICKETS),
              inArray(tickets.ticketPriority, URGENT),
            ),
          )
          .limit(50),
      [] as { id: string; customerId: string; summary: string; priority: string }[],
    ),
    safe(
      () =>
        tx
          .select({ id: todos.id, title: todos.title, dueAt: todos.dueAt })
          .from(todos)
          .where(
            and(
              eq(todos.orgId, org),
              eq(todos.done, false),
              ne(todos.status, "cancelled"),
              isNotNull(todos.dueAt),
              lt(todos.dueAt, now),
            ),
          )
          .orderBy(todos.dueAt)
          .limit(50),
      [] as { id: string; title: string; dueAt: Date | null }[],
    ),
    safe(
      () =>
        tx
          .select({
            id: deployments.deploymentId,
            customerId: deployments.customerId,
            health: deployments.healthStatus,
          })
          .from(deployments)
          .where(and(eq(deployments.orgId, org), ne(deployments.healthStatus, "Healthy")))
          .limit(50),
      [] as { id: string; customerId: string; health: string }[],
    ),
    safe(
      () =>
        tx
          .select({
            customerId: implementation.customerId,
            stage: implementation.implementationStage,
            risk: implementation.implementationRiskLevel,
            blocker: implementation.blocker,
          })
          .from(implementation)
          .where(
            and(
              eq(implementation.orgId, org),
              or(
                inArray(implementation.implementationRiskLevel, ["High", "Critical"]),
                isNotNull(implementation.blocker),
              ),
            ),
          )
          .limit(50),
      [] as { customerId: string; stage: string; risk: string; blocker: string | null }[],
    ),
    safe(
      () =>
        tx
          .select({
            id: workflowRuns.runId,
            name: workflowRuns.workflowName,
            status: workflowRuns.status,
          })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.orgId, org),
              eq(workflowRuns.status, "failed"),
              gt(workflowRuns.updatedAt, dayAgo),
            ),
          )
          .limit(50),
      [] as { id: string; name: string; status: string }[],
    ),
  ]),
  );

  const sections = [
    {
      key: "triage",
      label: "awaiting triage",
      count: triage.length,
      href: "/ops/inbox",
      sample: triage.slice(0, 3).map((r) => r.subject ?? "(no subject)"),
    },
    {
      key: "urgentTickets",
      label: "urgent open tickets",
      count: urgentTickets.length,
      href: "/ops/tickets",
      sample: urgentTickets.slice(0, 3).map((r) => `${r.customerId}: ${r.summary}`),
    },
    {
      key: "overdueTodos",
      label: "overdue tasks",
      count: overdueTodos.length,
      href: "/ops/todos",
      sample: overdueTodos.slice(0, 3).map((r) => r.title),
    },
    {
      key: "unhealthyDeployments",
      label: `${W.deployments} not healthy`,
      count: unhealthy.length,
      href: "/ops/deployments",
      sample: unhealthy.slice(0, 3).map((r) => `${r.customerId}/${r.id} — ${r.health}`),
    },
    {
      key: "implementationsAtRisk",
      label: `${W.implementations} at risk or blocked`,
      count: atRisk.length,
      href: "/ops/implementations",
      sample: atRisk.slice(0, 3).map((r) => `${r.customerId} — ${r.blocker ?? `${r.risk} risk`} (${r.stage})`),
    },
    {
      key: "failedRuns",
      label: "workflow runs failed (24h)",
      count: failedRuns.length,
      href: "/ops/workflows",
      sample: failedRuns.slice(0, 3).map((r) => r.name),
    },
  ].filter((s) => s.count > 0);

  return NextResponse.json({
    // Named, always: a count with no workspace attached is what made the
    // scattered version untrustworthy in the first place.
    orgId: org,
    generatedAt: now.toISOString(),
    total: sections.reduce((n, s) => n + s.count, 0),
    sections,
  });
}
