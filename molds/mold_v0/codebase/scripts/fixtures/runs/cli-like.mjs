// mold_v0-189: a stand-in for Claude Code before 2.1.304 on its first request. It sends `context_management` (the
// context-editing beta) unless CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is set, and a refused request ends it (exit 1),
// as the CLI's "API Error: 400 context_management: Extra inputs are not permitted" does. RUN_TARGETS
// {"ignore_flag": true} plays a CLI that does not know the setting; {"fail_after": true} fails after a good answer.
import { writeFileSync } from "node:fs";
import path from "node:path";

const say = (o) => console.log(JSON.stringify(o));
const targets = JSON.parse(process.env.RUN_TARGETS || "{}");
const betasOff = !!process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS && !targets.ignore_flag;
say({ event: "cli_env", betas_off: !!process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, quiet: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null });
const body = { model: "claude-opus-5-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hi" }],
  ...(betasOff ? {} : { context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }) };
const r = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
  method: "POST", body: JSON.stringify(body),
  headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "content-type": "application/json", "anthropic-version": "2023-06-01",
    "anthropic-beta": betasOff ? "claude-code-20250219" : "claude-code-20250219,context-management-2025-06-27" },
});
const text = await r.text();
say({ event: "model", status: r.status });
if (r.status !== 200) {
  let msg = text;
  try { msg = JSON.parse(text).error.message; } catch { /* as it came */ }
  console.error(`API Error: ${r.status} ${msg}`);
  process.exit(1);
}
if (targets.fail_after) { console.error("the session failed after the model answered"); process.exit(1); }
writeFileSync(path.join(process.env.RUN_OUT, "results.json"), "[]");
