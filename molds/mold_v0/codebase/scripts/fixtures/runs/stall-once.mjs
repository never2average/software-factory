// The first attempt stalls (the test kills its runner: a crashed sandbox); a later attempt does its job. mold_v0-055.
import { writeFileSync } from "node:fs";
import path from "node:path";

if (Number(process.env.RUN_ATTEMPT) === 1) {
  console.log(JSON.stringify({ event: "stalling" }));
  await new Promise((r) => setTimeout(r, 120_000));
  process.exit(0);
}
const targets = JSON.parse(process.env.RUN_TARGETS || "{}");
writeFileSync(path.join(process.env.RUN_OUT, "results.json"), JSON.stringify([{ check: { area: "run_checks", key: "c1" },
  asset: { area: "run_apps", key: targets.asset ?? "app-a" }, status: "pass", finding_fingerprint: "c1:retry" }]));
