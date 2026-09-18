import { NextRequest, NextResponse } from "next/server";
import { and, count, eq, isNotNull } from "drizzle-orm";
import {
  connectorSecrets,
  connectors,
  customers,
  orgMembers,
  orgs,
  peopleRoster,
  workflows,
} from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { canAccessOrg, orgContextForRequest, tenancyEnabled } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/orgs/{id}/health — org READINESS (the six setup checks).
 *
 * This is `fde:doctor` for a workspace, and it is the SINGLE SOURCE OF TRUTH for
 * the onboarding checklist: checks turn green here or not at all. Both onboarding
 * branches (manual + agent-runs-the-recipes) poll this, so the round-trip — a
 * remote agent's run ticking a check green — is verified, never asserted.
 *
 * Each check is `{ id, label, ok, detail, deepLink }`. The overall workspace is
 * "ready" when the load-bearing checks pass.
 */

type Check = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  deepLink: string;
  /**
   * True when this check cannot be evaluated here at all — pre-migration, the
   * tables it reads either don't carry org_id or don't exist. It used to report
   * `ok: true` in that case, which is exactly the say-so the setup screen
   * promises never to accept. Unverifiable is its own answer: not green, and
   * not counted toward readiness in either direction.
   */
  unverifiable?: boolean;
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  // A caller may only read the health of a workspace they belong to. Isolated
  // `personal:*` identities (fallback=true) must NOT reach another org here.
  if (!canAccessOrg(ctx, id)) {
    return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  }

  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const live = await tenancyEnabled(db);
  try {
   // connector_secrets is under STRICT RLS, so its count comes back 0 outside a
   // workspace-scoped transaction. Everything here is already scoped to `id`
   // anyway, so run the whole batch inside one.
   return await withOrgRls(id, async (db) => {
    const [memberN, rosterN, connN, secretN, wfN, custN, orgRow] = await Promise.all([
      live ? countWhere(db, orgMembers, eq(orgMembers.orgId, id)) : Promise.resolve(0),
      countWhere(db, peopleRoster, orgScoped(peopleRoster.orgId, id, live)),
      countWhere(db, connectors, orgScoped(connectors.orgId, id, live)),
      countWhere(db, connectorSecrets, orgScoped(connectorSecrets.orgId, id, live)),
      countWhere(db, workflows, orgScoped(workflows.orgId, id, live)),
      countWhere(db, customers, orgScoped(customers.orgId, id, live)),
      live
        ? db.select().from(orgs).where(eq(orgs.orgId, id)).limit(1).then((r) => r[0] ?? null)
        : Promise.resolve(null),
    ]);

    const checks: Check[] = [
      {
        id: "members",
        label: "Invite an owner and at least one admin",
        ok: live ? memberN >= 2 : false,
        unverifiable: !live,
        detail: live
          ? `${memberN} member${memberN === 1 ? "" : "s"}`
          : "single-workspace mode — membership isn't tracked yet",
        // People is the single roster + workspace-access surface; a separate
        // Members tab duplicated the same people and is intentionally gone.
        deepLink: "/workspace?tab=people",
      },
      {
        id: "roster",
        label: "Import the roster from Directory or a CSV",
        ok: rosterN > 0,
        detail: `${rosterN} on the roster`,
        // Opens the roster importer directly. It existed, but only behind a
        // button inside the workspace panel, so "Open →" landed on a page with
        // no visible way to do the thing the check was asking for.
        deepLink: "/workspace?tab=people&import=roster",
      },
      {
        id: "connector",
        label: "Connect one source and store its secret",
        ok: connN > 0 && secretN > 0,
        detail: `${connN} connector${connN === 1 ? "" : "s"}, ${secretN} secret${secretN === 1 ? "" : "s"}`,
        deepLink: "/?ops=connectors",
      },
      {
        id: "workflows",
        label: "Seed the workflow library and crons",
        ok: wfN > 0,
        detail: `${wfN} workflow${wfN === 1 ? "" : "s"}`,
        deepLink: "/?ops=workflows",
      },
      {
        id: "dataroom",
        label: "Write the data-room skeleton",
        ok: live ? Boolean(orgRow?.blobPrefix) : false,
        unverifiable: !live,
        detail: orgRow?.blobPrefix
          ? `prefix ${orgRow.blobPrefix}`
          : live
            ? "not provisioned"
            : "single-workspace mode — writes go to the legacy root",
        deepLink: "/workspace?tab=dataroom",
      },
      {
        id: "customer",
        label: "Onboard the first customer",
        ok: custN > 0,
        detail: `${custN} customer${custN === 1 ? "" : "s"}`,
        deepLink: "/?dataroom=customers",
      },
    ];

    // Load-bearing set for "ready": everything except the members check (a
    // solo pilot org can be healthy without a second admin).
    // "ready" ignores the members check (a solo pilot org is fine without a
    // second admin) and anything that couldn't be evaluated — an unverifiable
    // check neither blocks readiness nor is treated as passing.
    const loadBearing = checks.filter((c) => c.id !== "members" && !c.unverifiable);
    const ready = loadBearing.length > 0 && loadBearing.every((c) => c.ok);
    return NextResponse.json({
      orgId: id,
      ready,
      status: orgRow?.status ?? (live ? "unknown" : "active"),
      checks,
    });
   });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** Count rows in `table` matching `where` (undefined = whole table). */
async function countWhere(
  db: NonNullable<ReturnType<typeof getOpsDb>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: any,
): Promise<number> {
  const q = db.select({ n: count() }).from(table);
  const rows = where ? await q.where(where) : await q;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Scope predicate that is fail-safe pre-migration: when tenancy isn't live the
 * org_id column may not exist / all rows are the single org, so we count the
 * whole table (undefined predicate). Once live we filter by org_id, treating a
 * legacy NULL as the default org via COALESCE-free equality (backfill sets it).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function orgScoped(orgColumn: any, id: string, live: boolean) {
  if (!live) return undefined;
  return and(isNotNull(orgColumn), eq(orgColumn, id));
}
