// mold_v0-189: a real Claude Code binary (RUN_TARGETS {"bin": "<path>"}) for one print-mode turn, through the run's
// gateway, with the run's environment as the harness gives it. Exits as the CLI does; prints its JSON result's outcome.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const targets = JSON.parse(process.env.RUN_TARGETS || "{}");
const home = path.join(process.env.RUN_WORKSPACE, ".home");
mkdirSync(home, { recursive: true });
const r = spawnSync(targets.bin, ["-p", "--output-format", "json", "--model", "opus", "--permission-mode", "auto", "--max-turns", "2",
  "--setting-sources", "project", "--max-budget-usd", "1", "say ok"], {
  cwd: process.env.RUN_WORKSPACE, encoding: "utf8", timeout: 120_000,
  env: { ...process.env, HOME: home, ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-opus-5-5", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-opus-5-5" },
});
let out = {};
try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
console.log(JSON.stringify({ event: "claude", status: r.status, is_error: out.is_error ?? null, result: String(out.result ?? r.stderr ?? "").slice(0, 300) }));
if (r.status !== 0 || out.is_error) process.exit(1);
writeFileSync(path.join(process.env.RUN_OUT, "results.json"), "[]");
