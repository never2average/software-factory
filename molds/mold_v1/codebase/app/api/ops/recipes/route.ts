import { NextRequest, NextResponse } from "next/server";
import { asc, isNull, or, eq } from "drizzle-orm";
import { recipes } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest, tenancyEnabled } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/recipes — the recipe catalog the onboarding handoff hands to a
 * workspace's coding agents (the `--recipes a,b,c` pick-list). Returns the
 * built-in globals (org_id NULL) plus any this workspace has added/overridden.
 * "Extensibility = a row, not a code change."
 *
 * Fail-safe: pre-migration, returns the built-in set as a static fallback so the
 * onboarding UI renders before the registry table exists.
 */

const BUILTIN = [
  { slug: "onboard-self", title: "Sign in & record yourself", summary: "Get signed in, wired to the data room over MCP, and recorded as an operator.", satisfiesCheck: "members" },
  { slug: "import-roster", title: "Import the roster", summary: "Pull people from Google Directory or a CSV into the roster.", satisfiesCheck: "roster" },
  { slug: "connect-sources", title: "Connect a source", summary: "Wire one connector (GitHub, Slack, …) and store its secret.", satisfiesCheck: "connector" },
  { slug: "seed-workflows", title: "Seed the workflow library", summary: "Install the starter workflow library, default apps, and crons.", satisfiesCheck: "workflows" },
  { slug: "onboard-customer", title: "Onboard the first customer", summary: "Create the first customer account and its data-room skeleton.", satisfiesCheck: "customer" },
];

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) {
    return NextResponse.json({ items: BUILTIN.map((r, i) => ({ ...r, sortOrder: i, orgId: null })) });
  }
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(recipes)
        .where(or(isNull(recipes.orgId), eq(recipes.orgId, ctx.orgId)))
        .orderBy(asc(recipes.sortOrder), asc(recipes.slug)),
    );
    return NextResponse.json({ items: rows.length ? rows : BUILTIN.map((r, i) => ({ ...r, sortOrder: i, orgId: null })) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
