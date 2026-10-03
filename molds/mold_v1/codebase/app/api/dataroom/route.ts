/**
 * GET /api/dataroom              -> { paths: string[] }  (every logical dm.md
 *                                   file path in the data room; [] when no
 *                                   file store is configured: by default,
 *                                   when BLOB_READ_WRITE_TOKEN is unset)
 * GET /api/dataroom?path=<path>  -> { path, records } for .jsonl files,
 *                                   { path, content } otherwise,
 *                                   { path, found: false } when absent.
 * GET /api/dataroom?path=<path>&as=bytes
 *                                -> the object's BYTES as application/pdf, for
 *                                   the in-app viewer (app/_components/pdf-view.tsx).
 *
 * Read-only view over the private file store behind the DataroomStore
 * (`dataroom/` key prefix; Vercel Blob by default, or the driver STORAGE_DRIVER
 * selects: lib/storage). Uses lib/dataroom-blob.ts — a self-contained twin of
 * the store's object backend, on the same storage driver — because the
 * canonical agent/lib/dataroom-store.ts pulls the agent's module graph into
 * the Next bundle (same constraint as lib/ops-db.ts).
 *
 * WHY `as=bytes` IS A MODE OF THIS ROUTE AND NOT A NEW ONE. Every rule that
 * decides who may read a data-room file already lives here and runs before the
 * branch: the caller is verified and resolved to a workspace by
 * `orgContextForRequest`, and the path is checked by `isSafeDataroomPath`
 * before it is joined to that workspace's blob prefix. Reading the bytes of a
 * PDF is the same read as reading the text of the .md beside it — a second
 * route would be a second copy of those two checks, and the copy that drifts is
 * the one that leaks.
 *
 * tenancy-ok: no tenant rows are read; the blob prefix IS the tenant scope, and
 * it comes from ctx.orgId, never from the request.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  storageConfigured,
  isSafeDataroomPath,
  listDataroomPaths,
  openDataroomObject,
  parseJsonlRecords,
  readDataroomFile,
  statDataroomObject,
} from "@/lib/dataroom-blob";
import { orgContextForRequest } from "@/lib/org-context";
import {
  MAX_PDF_PREVIEW_BYTES,
  megabytes,
  refuseStoredPdf,
  statusForRefusal,
} from "@/lib/pdf-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The refusal a person ends up reading, keyed the way the viewer keys them. */
function refuse(code: string, message: string, status: number) {
  return NextResponse.json({ error: message, code }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: NextRequest) {
  // The data room is per-workspace: require a verified caller and read only
  // their org's tree (onfinance → legacy root; others → orgs/{id}/…).
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const path = request.nextUrl.searchParams.get("path");
  const wantsBytes = request.nextUrl.searchParams.get("as") === "bytes";

  try {
    // --- No path: list every logical file path in the store -----------------
    if (path === null || path === "") {
      if (!storageConfigured()) return NextResponse.json({ paths: [] });
      const paths = await listDataroomPaths(ctx.orgId);
      return NextResponse.json({ paths });
    }

    // --- With path: return that file's content ------------------------------
    if (!isSafeDataroomPath(path)) {
      return NextResponse.json({ error: "Invalid data-room path" }, { status: 400 });
    }

    /**
     * --- Bytes: the in-app PDF viewer's source for a STORED file -------------
     *
     * Only a .pdf. Not a general "give me any data-room object raw" door: the
     * text kinds are served as JSON above, and a mode that streams arbitrary
     * bytes would hand every audio file, workbook and Terraform plan a
     * same-origin download URL that nothing in the app asks for.
     *
     * SIZE IS DECIDED FIRST, from the listing, before a byte moves. `stat` is
     * one list call; without it a 44 MB transcript (a real one, in this
     * deployment) is pulled through the function and then into a tab that stops
     * answering. The person gets a sentence naming the limit instead.
     */
    if (wantsBytes) {
      if (!storageConfigured()) {
        return refuse("upstream_error", "Data room storage is not configured.", 503);
      }
      const stat = await statDataroomObject(path, ctx.orgId);
      if (stat === null) return refuse("upstream_missing", "That file is not in the data room.", 404);
      const refusal = refuseStoredPdf({ path, size: stat.size });
      if (refusal === "too_large") {
        return refuse(
          "too_large",
          // Says the size, says the limit, says what to do instead. "Preview
          // failed" sends a person hunting for a broken file; this one tells
          // them the file is fine and the browser is the constraint — and the
          // agent's own tools read the object from the store, with no ceiling.
          `This file is ${megabytes(stat.size)}. Anything over ${megabytes(MAX_PDF_PREVIEW_BYTES)} is too large to draw in a browser tab — ask the agent to read it for you instead.`,
          statusForRefusal(refusal),
        );
      }
      if (refusal !== null) {
        return refuse(refusal === "not_pdf" ? "not_pdf" : "bad_url", "Only a PDF can be previewed.", statusForRefusal(refusal));
      }
      const upstream = await openDataroomObject(path, ctx.orgId);
      if (upstream === null || upstream.body === null) {
        return refuse("upstream_missing", "That file is not in the data room.", 404);
      }
      return new NextResponse(upstream.body, {
        status: 200,
        headers: {
          // Declared, not sniffed: the bytes are drawn by pdf.js, never handed
          // to a plugin, and `nosniff` stops a mislabelled object being
          // interpreted as anything executable on our own origin.
          "content-type": "application/pdf",
          "x-content-type-options": "nosniff",
          "content-disposition": "inline",
          "content-length": String(stat.size),
          // PRIVATE and short: this response is one workspace's document, and a
          // shared cache holding it would serve it to the next signed-in caller.
          "cache-control": "private, max-age=60",
        },
      });
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
