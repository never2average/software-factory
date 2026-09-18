/**
 * GET /api/dataroom              -> { paths: string[] }  (every logical dm.md
 *                                   file path in the Blob data room; [] when
 *                                   BLOB_READ_WRITE_TOKEN is unset)
 * GET /api/dataroom?path=<path>  -> { path, records } for .jsonl files,
 *                                   { path, content } otherwise,
 *                                   { path, found: false } when absent.
 *
 * Read-only view over the private Vercel Blob store behind the DataroomStore
 * (`dataroom/` key prefix). Uses lib/dataroom-blob.ts — a self-contained
 * @vercel/blob twin of the store's Blob backend — because the canonical
 * agent/lib/dataroom-store.ts uses `.ts`-extension imports the Next bundler
 * cannot resolve (same constraint as lib/ops-db.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  blobToken,
  isSafeDataroomPath,
  listDataroomPaths,
  parseJsonlRecords,
  readDataroomFile,
} from "@/lib/dataroom-blob";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // The data room is per-workspace: require a verified caller and read only
  // their org's tree (onfinance → legacy root; others → orgs/{id}/…).
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const path = request.nextUrl.searchParams.get("path");

  try {
    // --- No path: list every logical file path in the store -----------------
    if (path === null || path === "") {
      if (!blobToken()) return NextResponse.json({ paths: [] });
      const paths = await listDataroomPaths(ctx.orgId);
      return NextResponse.json({ paths });
    }

    // --- With path: return that file's content ------------------------------
    if (!isSafeDataroomPath(path)) {
      return NextResponse.json({ error: "Invalid data-room path" }, { status: 400 });
    }
    const content = await readDataroomFile(path, ctx.orgId);
    if (content === null) {
      return NextResponse.json({ path, found: false });
    }
    if (path.endsWith(".jsonl")) {
      return NextResponse.json({ path, records: parseJsonlRecords(path, content) });
    }
    return NextResponse.json({ path, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Data-room read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
