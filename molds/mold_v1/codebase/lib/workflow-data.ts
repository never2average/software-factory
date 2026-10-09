import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  customers,
  deployments,
  implementation,
  interactions,
  peopleRoster,
  tickets,
} from "@/agent/lib/db/schema";
/**
 * The WEB-side data-room reader, not the agent's.
 *
 * agent/lib/dataroom-store.ts is not importable from the Next bundle — that is
 * exactly why lib/dataroom-blob.ts exists as its twin. Importing the agent's
 * copy here built cleanly and then threw at runtime, turning app refresh into
 * an unhandled 500.
 */
import { listDataroomPaths, readDataroomFile } from "@/lib/dataroom-blob";
import { isStorageConfigError } from "@/lib/storage/types";
import { withOrgRls } from "@/lib/ops-db";
import { accountOwnerSql } from "@/agent/lib/db/owner-columns";
import type { WorkflowData } from "@/lib/workflow-runtime";

/**
 * The data a workflow script may read for itself, bound to ONE workspace.
 *
 * A workflow should not depend on being handed variables. The app that runs
 * `renewal-risk` has no customer to pass it, and requiring a person to supply
 * one defeats the purpose — the script is supposed to work out its own scope.
 * Before this, its only route to the system of record was to ask the agent in
 * prose and parse the answer: slow, lossy, and a strange way to read a table
 * the workspace already owns.
 *
 * Bound here rather than inside the runtime on purpose. The runtime is a
 * sandbox host and imports no database; the workspace is closed over before
 * the script ever runs, so a script cannot widen its own scope by asking
 * differently. Reads go through withOrgRls, so the database enforces the same
 * boundary a second time.
 */
/** Options cross the sandbox boundary as JSON text; a script may send nothing. */
function parseOptions(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A ceiling the script cannot raise. These feed a model's context window, and
 * an unbounded read is how a workflow quietly turns into a context overflow.
 */
function limitOf(o: Record<string, unknown>, max: number): number {
  const asked = Number(o.limit);
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, max) : max;
}

export function workflowDataFor(orgId: string): WorkflowData {
  return {
    customers: async () =>
      withOrgRls(orgId, (tx) =>
        tx
          .select({
            id: customers.customerId,
            name: customers.customerName,
            tier: customers.tier,
            lifecycleStage: customers.lifecycleStage,
            status: customers.status,
            accountOwner: accountOwnerSql,
            companyDomain: customers.companyDomain,
          })
          .from(customers)
          .where(eq(customers.orgId, orgId))
          .orderBy(asc(customers.customerId)),
      ),

    /**
     * The rest of the system of record. Options arrive as JSON text because the
     * sandbox bridge carries strings; each is parsed defensively, since a script
     * may pass nothing at all.
     */
    tickets: async (optionsJson: string) => {
      const o = parseOptions(optionsJson);
      const open = ["Open", "In Progress", "Needs Triage", "Reopened", "Blocked"];
      return withOrgRls(orgId, (tx) =>
        tx
          .select({
            ticketId: tickets.ticketId,
            customerId: tickets.customerId,
            summary: tickets.summary,
            status: tickets.ticketStatus,
            priority: tickets.ticketPriority,
            type: tickets.ticketType,
          })
          .from(tickets)
          .where(
            and(
              eq(tickets.orgId, orgId),
              ...(o.customerId ? [eq(tickets.customerId, String(o.customerId))] : []),
              // "open" is the question people actually ask; pass status: "all"
              // to see everything rather than having to name five statuses.
              ...(o.status === "all" ? [] : [inArray(tickets.ticketStatus, open)]),
            ),
          )
          .limit(limitOf(o, 200)),
      );
    },

    deployments: async (optionsJson: string) => {
      const o = parseOptions(optionsJson);
      return withOrgRls(orgId, (tx) =>
        tx
          .select({
            deploymentId: deployments.deploymentId,
            customerId: deployments.customerId,
            environment: deployments.environment,
            version: deployments.deployedVersion,
            releaseStatus: deployments.releaseStatus,
            healthStatus: deployments.healthStatus,
          })
          .from(deployments)
          .where(
            and(
              eq(deployments.orgId, orgId),
              ...(o.customerId ? [eq(deployments.customerId, String(o.customerId))] : []),
            ),
          )
          .limit(limitOf(o, 200)),
      );
    },

    implementations: async (optionsJson: string) => {
      const o = parseOptions(optionsJson);
      return withOrgRls(orgId, (tx) =>
        tx
          .select({
            customerId: implementation.customerId,
            stage: implementation.implementationStage,
            risk: implementation.implementationRiskLevel,
            progressPct: implementation.implementationProgressPct,
            owner: implementation.implementationOwnerEmail,
            blocker: implementation.blocker,
          })
          .from(implementation)
          .where(
            and(
              eq(implementation.orgId, orgId),
              ...(o.customerId ? [eq(implementation.customerId, String(o.customerId))] : []),
            ),
          )
          .limit(limitOf(o, 200)),
      );
    },

    roster: async (optionsJson: string) => {
      const o = parseOptions(optionsJson);
      return withOrgRls(orgId, (tx) =>
        tx
          .select({
            email: peopleRoster.email,
            name: peopleRoster.name,
            team: peopleRoster.team,
            managerEmail: peopleRoster.managerEmail,
          })
          .from(peopleRoster)
          .where(eq(peopleRoster.orgId, orgId))
          .limit(limitOf(o, 500)),
      );
    },

    /** Newest first — "what happened lately" is the question being asked. */
    interactions: async (optionsJson: string) => {
      const o = parseOptions(optionsJson);
      return withOrgRls(orgId, (tx) =>
        tx
          .select({
            customerId: interactions.customerId,
            at: interactions.interactionAt,
            type: interactions.interactionType,
            summary: interactions.summary,
            outcome: interactions.outcome,
            nextAction: interactions.nextAction,
          })
          .from(interactions)
          .where(
            and(
              eq(interactions.orgId, orgId),
              ...(o.customerId ? [eq(interactions.customerId, String(o.customerId))] : []),
            ),
          )
          .orderBy(desc(interactions.interactionAt))
          .limit(limitOf(o, 100)),
      );
    },

    dataroomList: async (prefix: string) => {
      const all = await listDataroomPaths(orgId);
      return prefix ? all.filter((p) => p.startsWith(prefix)) : all;
    },

    /**
     * Missing reads as null rather than throwing: a script that surveys a tree
     * will meet files that do not exist for every customer, and making that an
     * exception would push try/catch into every loop.
     */
    dataroomRead: async (path: string) => {
      if (!path) return null;
      try {
        return await readDataroomFile(path, orgId);
      } catch (error) {
        // A misconfigured file store is not a missing file: the script fails, naming the setting (lib/storage).
        if (isStorageConfigError(error)) throw error;
        return null;
      }
    },
  };
}
