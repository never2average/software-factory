#!/usr/bin/env node
// The words a person READS for "who works here" and "what they cover" come from the deployment profile
// (profiles/*.json: vocabulary.member / owner / account). This gate fails when UI source hardcodes the default
// deployment's word "FDE" in text a person can see — the way four labels survived the move to profiles and showed
// "FDE owner" beside an analyst's name on a research deployment. Identifiers are fine (fdeOwner, fde-active-org,
// /api/…/fde…); comments are ignored; a deliberate exception carries `vocabulary-ok:` on its line.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(tsx|ts)$/.test(n) && !n.endsWith(".generated.ts") ? [p] : []; });
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, (m, a) => a);
// "FDE" as a word inside a string / template / JSX text. Not part of an identifier or a path.
const VISIBLE = /(^|[\s"'`>({,:])FDEs?(?=$|[\s"'`<).,:;!?}])/;
const problems = [];
for (const dir of ["app/_components", "app/onboard", "app/workspace", "components"]) {
  let files = []; try { files = walk(join(ROOT, dir)); } catch { continue; }
  for (const f of files) {
    const lines = decomment(readFileSync(f, "utf8")).split("\n");
    const raw = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!VISIBLE.test(line) || /vocabulary-ok:/.test(raw[i])) return;
      if (/^\s*(import|export type|type |interface )/.test(line)) return;
      problems.push(`${relative(ROOT, f)}:${i + 1}: ${raw[i].trim().slice(0, 140)}`);
    });
  }
}
if (problems.length) {
  console.error(`check-vocabulary: ${problems.length} place(s) hardcode "FDE" in text a person reads. Use DEPLOYMENT_PROFILE.vocabulary (member / owner), or mark a deliberate exception with "vocabulary-ok: <reason>".`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log('check-vocabulary: no hardcoded "FDE" in user-visible UI text');
