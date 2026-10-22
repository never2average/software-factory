// mold_v0-079 fixture: a dry run. Writes nothing to the workspace; its results say what the write would do.
import { writeFileSync } from "node:fs";
const scope = JSON.parse(process.env.RUN_SCOPE || "{}");
writeFileSync(`${process.env.RUN_OUT}/results.json`, JSON.stringify([{ check: { area: "approve_checks", key: "c1" }, status: "pass", detail: { would_add: scope.catalog ?? null } }]));
