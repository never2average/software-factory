import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { z } from "zod";
import {
  storageConfigured,
  isSafeDataroomPath,
  listDataroomPaths,
  parseJsonlRecords,
  readDataroomFile,
  writeDataroomFile,
} from "@/lib/dataroom-blob";
import { orgContextForRequest } from "@/lib/org-context";
import { recordOpsAudit } from "@/lib/ops-audit";
import { recordFileVersion } from "@/lib/dataroom-versions";
import { getOpsDb } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The data room over the authenticated Ops API.
 *
 * `/api/dataroom` is READ-only and serves the web console. This route adds
 * WRITES, scoped to the caller's workspace, so the CLI/MCP can configure a data
 * room without a production blob token on the machine and without a checkout of
 * this repo — previously the only way in, which meant the published CLI could
 * not touch the data room at all.
 *
 *   GET    ?prefix=      list logical paths
 *   GET    ?path=        read one file (jsonl comes back as parsed records)
 *   POST   {path, content, append?}   write a file, or append JSONL lines
 *
 * Every write is org-scoped and audited under the caller's identity.
 *
 * tenancy-ok: the only database write here is recordOpsAudit(), which now
 * opens its own workspace-scoped transaction (lib/ops-audit.ts). The data
 * room itself is blob storage, scoped by prefix via ctx.orgId.
 */

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  if (!storageConfigured()) return NextResponse.json({ error: "Data room storage is not configured." }, { status: 503 });
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  const prefix = url.searchParams.get("prefix") ?? "";
  try {
    if (path) {
      if (!isSafeDataroomPath(path)) return NextResponse.json({ error: "Unsafe path." }, { status: 400 });
      const content = await readDataroomFile(path, ctx.orgId);
      if (content === null) return NextResponse.json({ path, found: false });
      return path.endsWith(".jsonl")
        ? NextResponse.json({ path, found: true, records: parseJsonlRecords(path, content) })
        : NextResponse.json({ path, found: true, content });
    }
    const all = await listDataroomPaths(ctx.orgId);
    return NextResponse.json({ paths: prefix ? all.filter((p) => p.startsWith(prefix)) : all });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

const writeSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** Append to an existing .jsonl instead of replacing it. */
  append: z.boolean().optional(),
  /** Why this write happened + where the content came from. Audited, so the
   *  trail says WHY a file changed rather than only that it changed. */
  rationale: z.string().max(500).optional(),
  /**
   * Attach this write to a batch, so a backfill can be reviewed and reverted as
   * the one act it was rather than as N unrelated overwrites.
   */
  changesetId: z.uuid().optional(),
});

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (ctx instanceof Response) return ctx;
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!storageConfigured()) return NextResponse.json({ error: "Data room storage is not configured." }, { status: 503 });
  const parsed = writeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const { path, content, append, rationale, changesetId } = parsed.data;
  // The path guard is the whole security boundary here: it keeps a caller inside
  // the data room (no traversal, no escaping the workspace prefix).
  if (!isSafeDataroomPath(path)) return NextResponse.json({ error: "Unsafe path." }, { status: 400 });
  try {
    let body = content;
    if (append) {
      if (!path.endsWith(".jsonl")) {
        return NextResponse.json({ error: "append only applies to .jsonl paths." }, { status: 400 });
      }
      const existing = (await readDataroomFile(path, ctx.orgId)) ?? "";
      const head = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
      body = `${head}${content.endsWith("\n") ? content : `${content}\n`}`;
    }
    // BEFORE the overwrite: keep what it is about to destroy. The store writes
    // in place, so this is the only moment the previous bytes still exist.
    await recordFileVersion({
      orgId: ctx.orgId,
      path,
      actor: identity.email,
      changesetId,
      action: append ? "append" : "update",
      newBytes: body.length,
    });
    await writeDataroomFile(path, body, undefined, ctx.orgId);
    const db = getOpsDb();
    if (db) {
      void recordOpsAudit(db, {
        automationType: "dataroom",
        automationId: path,
        actor: identity.email,
        event: `${append ? "Appended to" : "Wrote"} ${path} (${body.length} bytes)${rationale ? ` — ${rationale}` : ""}`,
        orgId: ctx.orgId,
      });
    }
    return NextResponse.json({ ok: true, path, bytes: body.length });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
