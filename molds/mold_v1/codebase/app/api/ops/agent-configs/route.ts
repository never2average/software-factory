import { after, NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agentConfigs } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isOrgAdmin, orgContextForRequest, tenancyEnabled } from "@/lib/org-context";
import { isEmptyStore } from "@/lib/pg-error";
import { recordPromptVersion } from "@/lib/agent-prompt-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-subagent workspace config — pause/resume + per-agent instructions.
 *
 *  GET /api/ops/agent-configs         — this workspace's per-agent state.
 *  PUT /api/ops/agent-configs {agentKey, paused?, instructions?} — upsert one.
 *
 * Writes are admin/owner only. Fail-safe: no table → empty, so the Agents tab
 * still renders (every agent defaults to active, no custom instructions).
 */

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ items: [] });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) return NextResponse.json({ items: [], canEdit: isOrgAdmin(ctx.role) });
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(agentConfigs).where(eq(agentConfigs.orgId, ctx.orgId)),
    );
    return NextResponse.json({
      items: rows.map((r) => ({ agentKey: r.agentKey, paused: r.paused, instructions: r.instructions ?? null })),
      canEdit: isOrgAdmin(ctx.role),
    });
  } catch (e) {
    // Same rule as customers/ and chat-sessions/: only an absent table is
    // emptiness. A failed read shown as "no agent configs" invites someone to
    // recreate settings that already exist.
    if (isEmptyStore(e)) {
      return NextResponse.json({ items: [], canEdit: isOrgAdmin(ctx.role) });
    }
    console.error("agent-configs GET failed", e);
    return NextResponse.json({ error: "agent config store unavailable" }, { status: 503 });
  }
}

const putSchema = z.object({
  agentKey: z.string().min(1).max(80),
  paused: z.boolean().optional(),
  instructions: z.string().max(4000).nullable().optional(),
});

export async function PUT(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (ctx instanceof Response) return ctx;
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOrgAdmin(ctx.role)) return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!(await tenancyEnabled(db))) return NextResponse.json({ error: "Tenancy is not enabled yet." }, { status: 409 });
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  const { agentKey, ...fields } = parsed.data;
  const set: Record<string, unknown> = { updatedBy: identity.email.toLowerCase(), updatedAt: new Date() };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) set[k] = v;
  try {
    // Read the live text BEFORE overwriting it, so a no-op save (the editor
    // commits on blur whether or not anything changed) does not manufacture a
    // history entry that shows an empty diff.
    const [before] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select({ instructions: agentConfigs.instructions })
        .from(agentConfigs)
        .where(and(eq(agentConfigs.orgId, ctx.orgId), eq(agentConfigs.agentKey, agentKey)))
        .limit(1),
    );

    const [row] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(agentConfigs)
        .values({ orgId: ctx.orgId, agentKey, ...set })
        .onConflictDoUpdate({ target: [agentConfigs.orgId, agentConfigs.agentKey], set })
        .returning(),
    );

    if (fields.instructions !== undefined && (before?.instructions ?? null) !== (fields.instructions ?? null)) {
      /**
       * Off the response path.
       *
       * Recording history is an audit concern, not something the person typing
       * should wait on — and it was two extra round trips on a control that
       * fires every time you pause. `after` runs it once the response has been
       * flushed, so the editor stops saying "Saving…" as soon as the prompt is
       * actually stored. Failure is already swallowed inside the recorder: the
       * edit is what mattered.
       */
      after(
        recordPromptVersion(db, {
          orgId: ctx.orgId,
          agentKey,
          instructions: fields.instructions ?? null,
          actor: identity.email.toLowerCase(),
          // A first-ever version needs the pre-existing text behind it or the
          // first diff has nothing to compare against.
          seedPrevious: before === undefined ? null : (before.instructions ?? null),
        }),
      );
    }
    return NextResponse.json({ item: { agentKey: row.agentKey, paused: row.paused, instructions: row.instructions ?? null } });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
