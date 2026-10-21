// A run that does its job: calls the model through the gateway (when it has a provider), reports events, and writes
// results naming records of its own workspace. RUN_TARGETS {"asset": "<key>"} names the application it checks.
import { writeFileSync } from "node:fs";
import path from "node:path";

const say = (o) => console.log(JSON.stringify(o));
say({ event: "env", keys: Object.keys(process.env).sort() });
const targets = JSON.parse(process.env.RUN_TARGETS || "{}");
if (process.env.ANTHROPIC_BASE_URL) {
  const statuses = [];
  for (let i = 0; i < Number(targets.calls ?? 1); i++) {
    const r = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "fixture-model", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    });
    await r.text();
    statuses.push(r.status);
  }
  say({ event: "gateway", statuses });
}
console.log("plain log line");
const results = (targets.results ?? [{ check: { area: "run_checks", key: "c1" }, asset: { area: "run_apps", key: targets.asset ?? "app-a" },
  source: { area: "run_sources", key: "s1" }, status: "fail", finding_fingerprint: "c1:app:retention", evidence_ref: "evidence/logs.txt", detail: { note: "short retention" } }]);
writeFileSync(path.join(process.env.RUN_OUT, "results.json"), JSON.stringify(results));
