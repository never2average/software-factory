/**
 * Copy the data files pdf.js loads at RUN time into public/pdfjs/, so the in-app
 * PDF viewer can fetch them same-origin (the CSP allows nothing else):
 *
 *   wasm/            JPEG 2000 + JBIG2 decoders — scanned filings are full of both;
 *                    without them those pages render with blank images
 *   cmaps/           character maps for CJK and other predefined encodings
 *   standard_fonts/  the 14 standard fonts, for PDFs that do not embed them
 *   iccs/            colour profiles
 *
 * public/pdfjs is git-ignored: it is a copy of node_modules/pdfjs-dist at the
 * installed version, made by `prebuild` / `predev`, so it can never drift from
 * the library that reads it.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

const from = "node_modules/pdfjs-dist";
const to = "public/pdfjs";
if (!existsSync(from)) {
  console.error("copy-pdfjs-assets: pdfjs-dist is not installed");
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
for (const dir of ["wasm", "cmaps", "standard_fonts", "iccs"]) {
  cpSync(`${from}/${dir}`, `${to}/${dir}`, { recursive: true });
}
console.log(`copy-pdfjs-assets: ${to} refreshed`);
