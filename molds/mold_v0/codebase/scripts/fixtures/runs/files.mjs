// A workspace run that writes what it is told (mold_v0-056 fixture: the store's retention and file viewer are under
// test, not the program): RUN_SCOPE.write {path: text, or {base64}} is written into the workspace, RUN_SCOPE.remove
// [path] removed, RUN_SCOPE.results written as the run's results.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const scope = JSON.parse(process.env.RUN_SCOPE || "{}");
for (const [p, body] of Object.entries(scope.write ?? {})) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, typeof body === "string" ? body : Buffer.from(body.base64, "base64"));
}
for (const p of scope.remove ?? []) rmSync(p, { force: true, recursive: true });
writeFileSync(path.join(process.env.RUN_OUT, "results.json"), JSON.stringify(scope.results ?? []));
