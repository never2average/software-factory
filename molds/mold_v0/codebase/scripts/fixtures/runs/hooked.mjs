// A workspace run whose results name records its pack's onWorkspaceCommit hook indexes from the files it writes
// (mold_v0-064 fixture): items/<key>.json for each RUN_TARGETS.items key, and one result per item naming asset <key>.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const t = JSON.parse(process.env.RUN_TARGETS || "{}");
mkdirSync("items", { recursive: true });
for (const k of t.items ?? []) writeFileSync(`items/${k}.json`, JSON.stringify({ key: k, url: `https://${k}.example` }));
writeFileSync(path.join(process.env.RUN_OUT, "results.json"), JSON.stringify((t.items ?? []).map((k) => ({
  check: { area: "hook_checks", key: "c1" }, asset: { area: "hook_apps", key: k }, status: "pass" }))));
