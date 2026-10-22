// mold_v0-079 fixture: the write a preview showed: reads the approved preview's output (RUN_APPROVED_PREVIEW) and adds
// the catalog it named to the workspace.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const scope = JSON.parse(process.env.RUN_SCOPE || "{}");
const approved = JSON.parse(readFileSync(process.env.RUN_APPROVED_PREVIEW, "utf8"));
const would = approved.output?.results?.[0]?.detail?.would_add ?? null;
console.log(JSON.stringify({ event: "given", sha256: approved.sha256, would_add: would }));
mkdirSync(`${process.env.RUN_WORKSPACE}/catalogs`, { recursive: true });
writeFileSync(`${process.env.RUN_WORKSPACE}/catalogs/${would ?? scope.catalog}.json`, JSON.stringify({ catalog: would, run: process.env.RUN_ID }));
writeFileSync(`${process.env.RUN_OUT}/results.json`, "[]");
