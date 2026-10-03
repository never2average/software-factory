import { NextRequest, NextResponse } from "next/server";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { orgContextForRequest } from "@/lib/org-context";
import { blobToken, isSafeDataroomPath, writeDataroomFile } from "@/lib/dataroom-blob";
import { FOLDER } from "@/agent/lib/dataroom-folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/upload  (multipart/form-data, field `file`)
 *
 * Persists a user-uploaded file into the data room under the UPLOADER'S OWN
 * identity folder — {folder:uploads}/{person_id}/{filename} — so every upload lands as a
 * folder + file keyed to who uploaded it. The folder is derived from the
 * VERIFIED Google identity on the request (never from the client), so it can't
 * be spoofed. Returns the logical data-room path it was stored at.
 */
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

/** Slug an email/name into one safe path segment: priyesh@onfinance.in -> priyesh-onfinance-in. */
function personSlug(email: string): string {
  const s = email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "unknown";
}

/** Keep a filename to one safe segment (no traversal, no leading dot). */
function safeFilename(name: string): string {
  const base = (name.split(/[/\\]/).pop() ?? "file").trim();
  const cleaned = base.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^[._ ]+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
}

export async function POST(request: NextRequest) {
  // The proxy already gates /api/ops/*, but we re-verify here to get the email
  // that names the folder — the identity must come from the token, not the body.
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  /**
   * WHICH WORKSPACE the file belongs to. Without this the upload is written to
   * the legacy root prefix while every reader — the agent's data-room tools, the
   * Data Room page — looks under `…/orgs/<orgId>/`. The file lands somewhere
   * real and is invisible everywhere it is expected.
   *
   * It went unnoticed because the original workspace WAS the legacy root, so the
   * two paths coincided. The moment a second workspace existed (or this one was
   * recreated with a new id) every chat attachment started uploading fine and
   * then reporting "not found" the instant the agent tried to read it.
   */
  const org = await orgContextForRequest(request);
  if (org instanceof Response) return org;
  // No workspace, no write. This used to write with `org?.orgId`, and an undefined workspace meant the store's ROOT
  // — the prefix that holds every workspace's tree (lib/dataroom-keyspace.ts).
  if (!org?.orgId) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  if (!blobToken()) {
    return NextResponse.json({ error: "Data room storage is not configured." }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with a `file` field." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing `file`." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `File exceeds ${MAX_BYTES / (1024 * 1024)} MB.` }, { status: 413 });
  }

  const path = `${FOLDER.uploads}/${personSlug(identity.email)}/${safeFilename(file.name)}`;
  if (!isSafeDataroomPath(path)) {
    return NextResponse.json({ error: "Could not derive a safe data-room path." }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  await writeDataroomFile(path, bytes, file.type || undefined, org.orgId);

  return NextResponse.json({ ok: true, path, name: safeFilename(file.name), size: file.size });
}
