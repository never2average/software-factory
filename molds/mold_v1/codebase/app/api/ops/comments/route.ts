import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { comments } from "@/agent/lib/db/schema";
import { createDraft } from "@/agent/lib/email";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENTITIES = new Set(["task", "cycle", "deployment", "implementation"]);

/**
 * GET  /api/ops/comments?entity=<type>&id=<id> — the flat comment thread.
 * POST /api/ops/comments — add a comment; @-mentioned emails get a Drafts
 * notification (the platform is draft-only by design — it never sends).
 */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  const url = new URL(request.url);
  const entity = url.searchParams.get("entity") ?? "";
  const id = url.searchParams.get("id") ?? "";
  if (!ENTITIES.has(entity) || !id) return NextResponse.json({ error: "entity + id required" }, { status: 400 });
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(comments)
        .where(and(eq(comments.orgId, ctx.orgId), eq(comments.entityType, entity), eq(comments.entityId, id)))
        .orderBy(asc(comments.createdAt)),
    );
    return NextResponse.json({
      items: rows.map((r) => ({
        id: r.id,
        author: r.author,
        body: r.body,
        mentions: r.mentions ?? [],
        at: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

const postSchema = z.strictObject({
  entityType: z.enum(["task", "cycle", "deployment", "implementation"]),
  entityId: z.string().min(1),
  author: z.string().min(1).default("web"),
  body: z.string().min(1).max(8000),
  /** Human label for the entity, used only in the mention draft's subject. */
  label: z.string().optional(),
});

const MENTION_RE = /@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { entityType, entityId, author, body, label } = parsed.data;
  const mentions = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()))];
  try {
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(comments)
        .values({ orgId: ctx.orgId, entityType, entityId, author, body, mentions: mentions.length ? mentions : null })
        .returning(),
    );
    // Draft a notification per mention — best-effort, never blocks the comment,
    // and never SENDS (createDraft is an IMAP append, by design).
    for (const to of mentions) {
      void createDraft({
        to,
        subject: `${author} mentioned you on ${label ?? `${entityType} ${entityId}`}`,
        body: `${author} mentioned you in a comment on ${entityType} ${entityId}:\n\n${body}`,
      }, ctx.orgId).catch(() => {});
    }
    return NextResponse.json(
      { item: { id: item.id, author, body, mentions, at: item.createdAt.toISOString() } },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
