/**
 * The rules that decide whether a PDF in the DATA ROOM can be previewed, and
 * where its bytes come from.
 *
 * Pure (its one import is the deployment profile's folder names, plain data), and in `lib/` with no `server-only`, so the three
 * places that must agree import the same copy instead of each carrying a
 * number:
 *
 *   - `app/api/dataroom/route.ts`   — refuses an over-size object BEFORE it
 *     streams it, using the size the blob listing already reports;
 *   - `app/_components/pdf-view.tsx` — builds the request and caps what it
 *     reads, for the case where nothing declared a length;
 *   - `scripts/test-pdf-preview.mjs` — runs these decisions in CI.
 *
 * WHY A CEILING AT ALL. A data-room object has no size limit: chat uploads are
 * capped at 25 MB by /api/ops/upload, but anything the agent writes is not, and
 * the operator has already hit a 44 MB transcript that could not even be
 * cached. pdf.js parses from a single in-memory `Uint8Array`, so the whole file
 * is resident before page one paints — a 44 MB filing is ~44 MB of ArrayBuffer
 * plus the parsed object graph, on top of whatever the chat transcript is
 * already holding. Past a point the tab does not render slowly, it stops
 * answering. So the size is decided BEFORE a byte is fetched and the answer is
 * a sentence, not a spinner.
 *
 * WHY 40 MB. It is the cap the viewer has always applied to an external fetch
 * (`/api/ops/pdf-fetch`), so a file that previews from one source previews from
 * all of them; it is above the 25 MB upload cap, so nothing a person can attach
 * in chat is ever refused; and it is below the transcript size that has already
 * failed in this deployment.
 *
 * Note what is NOT bounded here: page count. A 400-page annual report inside
 * the ceiling is fine, because pdf-view.tsx renders only the pages near the
 * viewport and zeroes a canvas the moment it leaves (see PdfPage there).
 */

/** The largest PDF this app will pull into a browser tab to draw. */
export const MAX_PDF_PREVIEW_BYTES = 40 * 1024 * 1024;

/** Why a preview was refused. The viewer maps each to a sentence a person reads. */
import { ROOT_FOLDERS } from "../agent/lib/dataroom-folders.ts";

export type PdfPreviewRefusal = "bad_path" | "not_pdf" | "too_large";

/** 40 MB → "40 MB". For the one message that has to name the limit. */
export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * The data-room path grammar, client-side.
 *
 * A DELIBERATE TWIN of `isSafeDataroomPath` in lib/dataroom-blob.ts, which is
 * `server-only` and therefore cannot be imported by a client component. The
 * server's copy is the one that enforces; this one exists so a malformed path —
 * which in the chat arrives from MESSAGE TEXT (`extractAttachmentRefs`) and is
 * therefore attacker-shaped input — never becomes a request at all, and so a
 * chip for something that is not a data-room file is not rendered as clickable.
 *
 * It is deliberately no LOOSER than the server's: same eight folder roots (the profile's), same
 * per-segment pattern, same refusal of "\", a leading "/" and a trailing "/".
 * Being stricter here would only hide files; being looser would only produce a
 * 400. Neither can grant a read the server would not.
 */
const DATAROOM_DOMAINS = new Set(ROOT_FOLDERS);
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

export function isDataroomPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("\\") || path.startsWith("/") || path.endsWith("/")) return false;
  const segments = path.split("/");
  if (segments.length < 2 || !DATAROOM_DOMAINS.has(segments[0])) return false;
  return segments.every((segment) => SAFE_SEGMENT.test(segment));
}

/** Is this data-room path something the in-app PDF viewer can open? */
export function isPreviewablePdfPath(path: unknown): path is string {
  return isDataroomPath(path) && /\.pdf$/i.test(path);
}

/**
 * Where the viewer reads a data-room PDF's bytes from.
 *
 * SAME-ORIGIN, and that is the point. The data room's own reads are private
 * blobs behind a short-lived presigned GET
 * (`…private.blob.vercel-storage.com/dataroom/orgs/<org>/…?vercel-blob-delegation=…`).
 * That query string is a bearer capability for one object: anyone holding it
 * reads the file, signed in or not, until it expires. The viewer therefore
 * never receives one. The route mints it inside the Node function, streams the
 * bytes back, and the signed URL is not in any response body, any DOM
 * attribute, any history entry or any log the browser keeps — exactly where it
 * was before this feature existed.
 *
 * The caller's identity travels the way every other data-room read travels: the
 * bearer on the request (`opsFetchRaw`), which the route turns into a workspace
 * through `orgContextForRequest`. There is no token in this URL, so it is safe
 * to put in a link, and useless to anyone else if it leaks.
 */
export function dataroomPdfHref(path: string): string {
  return `/api/dataroom?path=${encodeURIComponent(path)}&as=bytes`;
}

/**
 * The server's answer for one stored object, decided from its LISTED metadata
 * before anything is fetched.
 *
 * `size` is null when the listing did not report one; we then let it through and
 * the streaming cap in the viewer (`readCapped`) is the backstop — a missing
 * size must not make a readable file unreadable.
 */
export function refuseStoredPdf(meta: {
  readonly path: string;
  readonly size?: number | null;
}): PdfPreviewRefusal | null {
  if (!isDataroomPath(meta.path)) return "bad_path";
  if (!/\.pdf$/i.test(meta.path)) return "not_pdf";
  const size = meta.size;
  if (typeof size === "number" && Number.isFinite(size) && size > MAX_PDF_PREVIEW_BYTES) {
    return "too_large";
  }
  return null;
}

/** HTTP status for a refusal — the same mapping lib/safe-fetch.ts uses. */
export function statusForRefusal(refusal: PdfPreviewRefusal): number {
  if (refusal === "too_large") return 413;
  if (refusal === "not_pdf") return 415;
  return 400;
}
