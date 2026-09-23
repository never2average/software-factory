/**
 * The rules that let an UPLOADED pdf be previewed — run, not described.
 *
 * The viewer (app/_components/pdf-view.tsx) has always worked; what it was
 * wired to was a pdf the AGENT published, which on a research desk is the one
 * pdf nobody uploaded. A filing dropped into the data room, or a deck attached
 * in chat, was listed and downloadable and could not be looked at. Closing that
 * meant a new source for the viewer, a bytes mode on /api/dataroom, and a size
 * ceiling — and all three have to agree about the same three questions:
 *
 *   1. is this path a data-room pdf at all?
 *   2. is the file small enough to draw in a browser tab?
 *   3. where are its bytes read from, and what must never appear in that url?
 *
 * They agree by importing lib/pdf-preview.ts, which is what this executes. The
 * last section is a source ratchet over the three files that SHIP the wiring —
 * the part a pure module cannot hold, and the part a browser test would hold if
 * CI ran one (it does not run Playwright).
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-pdf-preview.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const source = (p) => readFileSync(join(ROOT, p), "utf8");

const {
  MAX_PDF_PREVIEW_BYTES,
  dataroomPdfHref,
  isDataroomPath,
  isPreviewablePdfPath,
  megabytes,
  refuseStoredPdf,
  statusForRefusal,
} = await import("../lib/pdf-preview.ts");

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

/* --- 1. The path grammar ---------------------------------------------------
 *
 * In the chat this input is MESSAGE TEXT: `extractAttachmentRefs` reads the
 * path out of a block a person can type by hand. So the interesting cases are
 * not typos, they are the paths someone would write on purpose. */

console.log("Which paths are data-room pdfs:");

const REAL = "Uploads/priyesh-onfinance-in/SEBI LODR Q3 FY26.pdf";
check("a real uploaded filing is one", isPreviewablePdfPath(REAL));
check("…and so is an investor deck with an uppercase extension", isPreviewablePdfPath("Uploads/a-b-c/Deck.PDF"));
check("a data-room path under another domain is one", isPreviewablePdfPath("Customers/axis-bank/brief.pdf"));

check("traversal out of the room is not", !isDataroomPath("Uploads/../../etc/passwd"));
check("…nor is traversal spelled with a domain prefix", !isPreviewablePdfPath("Uploads/../Customers/x.pdf"));
check("a backslash is not a path separator here", !isDataroomPath("Uploads\\x\\y.pdf"));
check("an absolute path is not one", !isDataroomPath("/Uploads/x/y.pdf"));
check("a trailing slash is not one", !isDataroomPath("Uploads/x/"));
check("a bare domain with no file is not one", !isDataroomPath("Uploads"));
check("a domain nobody serves is not one", !isDataroomPath("Secrets/x/y.pdf"));
check("a hidden dotfile segment is not one", !isDataroomPath("Uploads/.ssh/id_rsa.pdf"));
check("an empty segment is not one", !isDataroomPath("Uploads//y.pdf"));
check("a non-string is not one", !isDataroomPath(undefined) && !isDataroomPath(null) && !isDataroomPath(42));

/* A valid data-room path that is not a pdf must not open the pdf viewer — the
 * mode exists for the one type pdf.js draws, not as a raw-bytes door onto every
 * object in the room. */
check("a workbook is a data-room path but not previewable", isDataroomPath("Customers/x/Master.xlsx") && !isPreviewablePdfPath("Customers/x/Master.xlsx"));
check("audio is left exactly as it was", !isPreviewablePdfPath("Tickets/x/call.m4a"));
check("a name that merely CONTAINS pdf is not one", !isPreviewablePdfPath("Uploads/x/pdf-notes.txt"));

/* The twin. `isSafeDataroomPath` in lib/dataroom-blob.ts is the guard that
 * ENFORCES; it is `server-only` and cannot be imported by a client component, so
 * lib/pdf-preview.ts carries a copy. A copy that drifts LOOSER would send
 * requests the server refuses; a copy that drifts STRICTER would hide a file
 * that is really there. Both halves are in this repo and neither is applied by a
 * pack, so comparing them is comparing what ships. */
{
  const server = source("lib/dataroom-blob.ts");
  const domains = [...server.matchAll(/^\s*"([A-Z][A-Za-z]*)",$/gm)].map((m) => m[1]);
  check("the server declares its domain roots where this can read them", domains.length >= 8);
  for (const domain of domains) {
    check(`domain "${domain}" is accepted by the client twin too`, isDataroomPath(`${domain}/x/y.pdf`));
  }
  const segment = /const SAFE_SEGMENT = (\/.*\/);/.exec(server);
  check("the server's per-segment pattern is still the one this twin copies", segment?.[1] === "/^[A-Za-z0-9][A-Za-z0-9._ -]*$/");
}

/* --- 2. The size ceiling ---------------------------------------------------
 *
 * pdf.js parses from one in-memory Uint8Array, so the whole file is resident
 * before page one paints. The operator has already hit a 44 MB object in this
 * deployment. The decision is made from the blob listing's `size`, before a
 * byte is fetched. */

console.log("\nHow large is too large:");

const MB = 1024 * 1024;
check("the ceiling is 40 MB", MAX_PDF_PREVIEW_BYTES === 40 * MB);
/* /api/ops/upload caps an attachment at 25 MB, so a file a person can attach in
 * chat must never be refused by the previewer that opens it. */
{
  const uploadCap = /MAX_BYTES = (\d+) \* 1024 \* 1024/.exec(source("app/api/ops/upload/route.ts"));
  check("…which is above the chat upload cap, so nothing attachable is refused", Number(uploadCap?.[1]) * MB < MAX_PDF_PREVIEW_BYTES);
}
check("a 44 MB transcript is refused", refuseStoredPdf({ path: REAL, size: 44 * MB }) === "too_large");
check("…exactly at the ceiling is allowed", refuseStoredPdf({ path: REAL, size: 40 * MB }) === null);
check("…one byte over is not", refuseStoredPdf({ path: REAL, size: 40 * MB + 1 }) === "too_large");
check("a 3 MB filing sails through", refuseStoredPdf({ path: REAL, size: 3 * MB }) === null);
/* A listing that reported no size must not make a readable file unreadable —
 * the viewer's streaming cap is the backstop for that case. */
check("an unknown size is allowed through to the streaming cap", refuseStoredPdf({ path: REAL, size: null }) === null);
check("…and so is a size that is not a number", refuseStoredPdf({ path: REAL, size: Number.NaN }) === null);
check("a bad path is refused before size is even considered", refuseStoredPdf({ path: "../x.pdf", size: 1 }) === "bad_path");
check("a non-pdf in the room is refused", refuseStoredPdf({ path: "Customers/x/Master.xlsx", size: 1 }) === "not_pdf");

check("too large answers 413, the status the viewer already reads as 'too large'", statusForRefusal("too_large") === 413);
check("not a pdf answers 415", statusForRefusal("not_pdf") === 415);
check("a bad path answers 400", statusForRefusal("bad_path") === 400);
/* 401 is the SIGN-IN answer and nothing else may borrow it: the viewer turns a
 * 401 into "sign in again", which is the wrong sentence for any of these. */
for (const refusal of ["too_large", "not_pdf", "bad_path"]) {
  check(`${refusal} never answers 401`, statusForRefusal(refusal) !== 401);
}

check("the limit reads as a round '40 MB' in a sentence", megabytes(MAX_PDF_PREVIEW_BYTES) === "40 MB");
check("a real file size keeps one decimal where it matters", megabytes(3.5 * MB) === "3.5 MB");
check("…and drops it once the number is large", megabytes(44 * MB) === "44 MB");

/* --- 3. Where the bytes come from, and what is not in that url -------------
 *
 * A data-room read is a private blob behind a presigned GET whose query string
 * IS the authority: anyone holding
 * `…private.blob.vercel-storage.com/dataroom/orgs/<org>/…?vercel-blob-delegation=…`
 * reads that object, signed in or not, until it expires. The viewer must never
 * be handed one. */

console.log("\nWhere a stored pdf is read from:");

const href = dataroomPdfHref(REAL);
check("the viewer reads same-origin, from this app", href.startsWith("/api/dataroom?"));
check("…in the bytes mode", href.includes("as=bytes"));
check("no blob host appears in the url the browser sees", !/vercel-storage\.com/.test(href));
check("no presigned signature appears in it", !/delegation|signature|X-Amz|token=/i.test(href));
check("the path is encoded, so a space cannot end the parameter", dataroomPdfHref("Uploads/a b/c d.pdf").includes("Uploads%2Fa%20b%2Fc%20d.pdf"));
check("…and an ampersand cannot add one", !dataroomPdfHref("Uploads/x/a&as=bytes&path=y.pdf").includes("&as=bytes&path=y"));
check("…and a hash cannot truncate it", dataroomPdfHref("Uploads/x/a#b.pdf").includes("%23"));
check("the path round-trips exactly", decodeURIComponent(new URLSearchParams(href.split("?")[1]).get("path")) === REAL);

/* --- 4. The ratchet on what actually ships --------------------------------
 *
 * Everything above is a pure module. These four facts are about the files that
 * wire it up, and each one is the regression that would silently restore the
 * gap: the viewer losing the source, the data room going back to a placeholder
 * card, the route losing a check, or the signed url escaping the function.
 * CI runs no browser, so this is the guard that runs. */

console.log("\nThe wiring that ships:");

{
  const viewer = source("app/_components/pdf-view.tsx");
  check("the viewer takes a data-room path", /readonly dataroomPath\?: string/.test(viewer));
  check("…and builds its request with the shared helper", /dataroomPdfHref\(/.test(viewer) && /from "@\/lib\/pdf-preview"/.test(viewer));
  check("…carrying the signed-in bearer, not a bare fetch", /opsFetchRaw\(dataroomPdfHref\(/.test(viewer));
  check("…and refuses at the shared ceiling, not a second number of its own", /MAX_PREVIEW_BYTES = MAX_PDF_PREVIEW_BYTES/.test(viewer));
  check("it is still the only viewer: nothing else mounts pdfjs", !/getDocument\(/.test(source("app/_components/dataroom.tsx")) && !/getDocument\(/.test(source("app/_components/agent-message.tsx")));
}
{
  const room = source("app/_components/dataroom.tsx");
  check("the data room renders a pdf with THE viewer", /<PdfView dataroomPath=\{file\.path\}/.test(room));
  check("…and audio is left on the placeholder card", /file\.kind === "audio"/.test(room));
}
{
  const chat = source("app/_components/agent-message.tsx");
  check("an attached pdf chip opens the same viewer", /<PdfView dataroomPath=\{path\}/.test(chat));
  check("…gated on the path, not on the displayed name", /isPreviewablePdfPath\(file\.path\)/.test(chat));
  check("…and image inlining in the composer is untouched", /mediaType\.startsWith\("image\/"\)/.test(source("app/_components/agent-chat.tsx")));
}
{
  const route = source("app/api/dataroom/route.ts");
  check("the bytes mode is behind the workspace resolver", route.indexOf("orgContextForRequest(request)") < route.indexOf('as") === "bytes"'));
  check("…and behind the path guard", route.indexOf("isSafeDataroomPath(path)") < route.indexOf("if (wantsBytes)"));
  check("…and refuses on the LISTED size, before opening the object", route.indexOf("statDataroomObject(path,") < route.indexOf("openDataroomObject(path,"));
  check("…and answers application/pdf with nosniff", /"content-type": "application\/pdf"/.test(route) && /"x-content-type-options": "nosniff"/.test(route));
  check("…and is never cached by a shared cache", /"cache-control": "private/.test(route));
  /* The one thing that would turn this into a leak: handing the caller the
   * presigned url instead of the bytes, as a body field or a redirect. */
  check("the presigned url is never returned or redirected to", !/redirect\(/.test(route) && !/\burl\b\s*[,:]/.test(route.slice(route.indexOf("wantsBytes"))));
}

console.log(`\npdf preview rules: ${passed}/${passed} checks passed`);
