import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { z } from "zod";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { changesetDiff, getChangeset, readSnapshot, revertChangeset } from "@/lib/dataroom-versions";
import { storageMisconfigured } from "@/lib/storage-http";
import { recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb } from "@/lib/ops-db";
import { isOrgAdmin, orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 *   GET  ?path=…   one changeset, its files, or the pre-write bytes of one file
 *   POST {revert}  put every file back to what it was before the batch
 *
 * tenancy-ok: the changeset store is blob-backed and scoped by workspace
 * prefix — every helper here is handed ctx.orgId. No tenant table is read.
 */
const uuidSchema = z.uuid();

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const misconfigured = storageMisconfigured();
  if (misconfigured) return misconfigured;
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid changeset id" }, { status: 400 });
  }
  try {
    const params = new URL(request.url).searchParams;
    if (params.get("diff") === "1") {
      // Every file's real before/after in ONE request: the panel used to fetch
      // per file and reconstruct the after-side from the CURRENT content, which
      // is only correct for the newest write to a path.
      return NextResponse.json({ files: await changesetDiff(ctx.orgId, id) });
    }
    const path = params.get("path");
    if (path) {
      // The bytes this changeset replaced at `path` — the "before" side of a diff.
      const before = await readSnapshot(ctx.orgId, id, path);
      return NextResponse.json({ path, before, existed: before !== null });
    }
    const found = await getChangeset(ctx.orgId, id);
    if (!found) return NextResponse.json({ error: "Changeset not found" }, { status: 404 });
    return NextResponse.json(found);
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (ctx instanceof Response) return ctx;
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Reverting rewrites many files at once. That is an administrative act on the
  // workspace's record, not an ordinary edit.
  if (!isOrgAdmin(ctx.role)) {
    return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  }
  const misconfigured = storageMisconfigured();
  if (misconfigured) return misconfigured;
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid changeset id" }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  if (!body || body.revert !== true) {
    return NextResponse.json({ error: "Send { revert: true }." }, { status: 400 });
  }
  try {
    const found = await getChangeset(ctx.orgId, id);
    if (!found) return NextResponse.json({ error: "Changeset not found" }, { status: 404 });
    if (found.changeset.status === "reverted") {
      return NextResponse.json({ error: "This changeset was already reverted." }, { status: 409 });
    }
    const result = await revertChangeset(ctx.orgId, id, identity.email);
    const db = getOpsDb();
    if (db) {
      void recordOpsAudit(db, {
        automationType: "dataroom",
        automationId: id,
        actor: identity.email,
        orgId: ctx.orgId,
        event:
          `Reverted changeset "${found.changeset.label}" — ` +
          `${result.restored.length} restored, ${result.emptied.length} emptied` +
          (result.failed.length ? `, ${result.failed.length} FAILED` : ""),
      });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}
