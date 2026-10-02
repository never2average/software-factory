import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { asc, eq } from "drizzle-orm";
import { recipes } from "@/agent/lib/db/schema";
import { BUILTIN_RECIPES } from "@/agent/lib/provision-workspace";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest, tenancyEnabled } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/recipes — the recipe catalog the onboarding handoff hands to a
 * workspace's coding agents (the `--recipes a,b,c` pick-list). Returns this
 * workspace's rows: the built-in catalog provisionWorkspace seeded into it plus
 * any it has added/overridden. "Extensibility = a row, not a code change."
 *
 * There is no `org_id IS NULL` "global" branch: `recipes.org_id` is NOT NULL
 * and the fail-closed policy scopes reads to one org, so a global row cannot
 * exist and the branch only made it look as though one could.
 *
 * Fail-safe: pre-migration, or for a workspace provisioned before the catalog
 * was seeded per org, returns the built-in set as a static fallback so the
 * onboarding UI renders. The fallback is the same list the seeder writes.
 */

const BUILTIN = BUILTIN_RECIPES.map((r, i) => ({ ...r, sortOrder: i, orgId: null }));

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) {
    return NextResponse.json({ items: BUILTIN });
  }
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(recipes)
        .where(eq(recipes.orgId, ctx.orgId))
        .orderBy(asc(recipes.sortOrder), asc(recipes.slug)),
    );
    return NextResponse.json({ items: rows.length ? rows : BUILTIN });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
