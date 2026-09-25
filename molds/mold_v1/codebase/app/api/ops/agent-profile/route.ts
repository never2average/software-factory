import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import { agentProfiles } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isOrgAdmin, orgContextForRequest, tenancyEnabled } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Personalize my agent."
 *
 *  GET  /api/ops/agent-profile  — the workspace default, the caller's own
 *       override, the effective merge, and the caller's role.
 *  PUT  /api/ops/agent-profile  — upsert a scope. scope "org" (workspace default)
 *       is admin/owner only; scope "me" writes the caller's own override.
 *
 * Fail-safe: no DB / table absent → an empty profile so the tab still renders.
 */

const FIELDS = [
  "personaName",
  "tone",
  "instructions",
  "defaultMode",
  "webSearchDefault",
  "browserDefault",
  "model",
] as const;

type ProfileRow = typeof agentProfiles.$inferSelect;
function view(r: ProfileRow | undefined) {
  if (!r) return null;
  return Object.fromEntries(FIELDS.map((f) => [f, r[f as keyof ProfileRow] ?? null]));
}
function mergeEffective(def: ProfileRow | undefined, mine: ProfileRow | undefined) {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    const dv = def?.[f as keyof ProfileRow];
    const mv = mine?.[f as keyof ProfileRow];
    out[f] = mv !== null && mv !== undefined ? mv : (dv ?? null);
  }
  return out;
}

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) {
    return NextResponse.json({ orgDefault: null, mine: null, effective: null, role: ctx.role, canEditOrg: isOrgAdmin(ctx.role) });
  }
  try {
    const email = identity.email.toLowerCase();
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(agentProfiles)
        .where(and(eq(agentProfiles.orgId, ctx.orgId), inArray(agentProfiles.email, ["", email]))),
    );
    const def = rows.find((r) => r.email === "");
    const mine = rows.find((r) => r.email === email);
    return NextResponse.json({
      orgDefault: view(def),
      mine: view(mine),
      effective: mergeEffective(def, mine),
      role: ctx.role,
      canEditOrg: isOrgAdmin(ctx.role),
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

const putSchema = z.object({
  scope: z.enum(["org", "me"]),
  personaName: z.string().trim().max(60).nullable().optional(),
  tone: z.string().trim().max(200).nullable().optional(),
  instructions: z.string().max(4000).nullable().optional(),
  defaultMode: z.enum(["build", "plan", "goal", "loop"]).nullable().optional(),
  webSearchDefault: z.boolean().nullable().optional(),
  browserDefault: z.boolean().nullable().optional(),
  model: z.string().trim().max(120).nullable().optional(),
});

export async function PUT(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!(await tenancyEnabled(db))) {
    return NextResponse.json({ error: "Tenancy is not enabled yet (migration pending)." }, { status: 409 });
  }
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const { scope, ...fields } = parsed.data;
  if (scope === "org" && !isOrgAdmin(ctx.role)) {
    return NextResponse.json({ error: "Only an admin or owner can set the workspace default." }, { status: 403 });
  }
  const email = scope === "org" ? "" : identity.email.toLowerCase();
  const set: Record<string, unknown> = { updatedBy: identity.email.toLowerCase(), updatedAt: new Date() };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) set[k] = v;
  try {
    const [row] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(agentProfiles)
        .values({ id: nanoid(), orgId: ctx.orgId, email, ...set })
        .onConflictDoUpdate({ target: [agentProfiles.orgId, agentProfiles.email], set })
        .returning(),
    );
    return NextResponse.json({ item: view(row) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
