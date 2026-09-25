import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { z } from "zod";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { commitChangeset, listChangesets, openChangeset } from "@/lib/dataroom-versions";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Data-room changesets — a batch of writes treated as one act.
 *
 *   GET               recent batches, newest first, with file counts
 *   POST {label}      open one; writes then reference it
 *   POST {id, commit} close it
 */
const postSchema = z.union([
  z.strictObject({
    label: z.string().min(1).max(200),
    rationale: z.string().max(1000).optional(),
    source: z.enum(["cli", "agent", "web"]).optional(),
    unattended: z.boolean().optional(),
  }),
  z.strictObject({ id: z.uuid(), commit: z.literal(true) }),
]);

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ items: await listChangesets(ctx.orgId) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  try {
    if ("commit" in parsed.data) {
      const { files } = await commitChangeset(ctx.orgId, parsed.data.id);
      return NextResponse.json({ ok: true, id: parsed.data.id, files });
    }
    const { id } = await openChangeset({
      orgId: ctx.orgId,
      label: parsed.data.label,
      actor: identity.email,
      source: parsed.data.source ?? "web",
      rationale: parsed.data.rationale ?? null,
      unattended: parsed.data.unattended ?? false,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
