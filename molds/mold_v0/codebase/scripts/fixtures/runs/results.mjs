// Writes RUN_SCOPE.results as the run's results (mold_v0-065 fixture: the engine's handling of result identity and
// unresolved references is what is under test, not the program).
import { writeFileSync } from "node:fs";
import path from "node:path";

const scope = JSON.parse(process.env.RUN_SCOPE || "{}");
writeFileSync(path.join(process.env.RUN_OUT, "results.json"), JSON.stringify(scope.results ?? []));
