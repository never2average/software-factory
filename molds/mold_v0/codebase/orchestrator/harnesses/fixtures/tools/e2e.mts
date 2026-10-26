// Drive each adapter's real launch + resume argv inside its warm pod against the mock LLM (no API spend).
// Needs the images (orchestrator/images/build.sh) and the mock running on the host:
//   node orchestrator/harnesses/fixtures/tools/mock-llm.mjs &
//   npx tsx orchestrator/harnesses/fixtures/tools/e2e.mts [harness...]
// Not covered: cursor and amp (their backends are proprietary, not mockable) and cline (adapter hardcodes provider anthropic).
import { spawnSync, execFileSync } from "node:child_process";
import { getAdapter } from "../../adapters.js";

const M = "http://127.0.0.1:18080";
type Case = { img: string; model: string; extraEnv?: Record<string, string>; files?: Record<string, string> };
const CASES: Record<string, Case> = {
  copilot: { img: "app/agent-copilot:1.0.95", model: "gpt-4.1", extraEnv: { COPILOT_PROVIDER_BASE_URL: `${M}/v1`, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_API_KEY: "mock-provider-key-0000", COPILOT_GITHUB_TOKEN: "gho_mock_token_0000" } },
  opencode: { img: "app/agent-opencode:1.18.35", model: "anthropic/claude-sonnet-4-5", extraEnv: { ANTHROPIC_API_KEY: "mock-key-0000", OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { anthropic: { options: { baseURL: `${M}/v1` } } } }) } },
  kilo: { img: "app/agent-kilo:7.8.8", model: "anthropic/claude-sonnet-4-5", extraEnv: { ANTHROPIC_API_KEY: "mock-key-0000", KILO_CONFIG_CONTENT: JSON.stringify({ provider: { anthropic: { options: { baseURL: `${M}/v1` } } } }) } },
  "gemini-cli": { img: "app/agent-gemini-cli:0.63.0", model: "gemini-2.5-pro", extraEnv: { GEMINI_API_KEY: "mock-gemini-key-0000", GOOGLE_GEMINI_BASE_URL: M }, files: { ".gemini/settings.json": '{"security":{"auth":{"selectedType":"gemini-api-key"}}}' } },
  "qwen-code": { img: "app/agent-qwen-code:0.25.0", model: "mock-model", extraEnv: { DASHSCOPE_API_KEY: "mock-key-0000", DASHSCOPE_BASE_URL: `${M}/v1` } },
  pi: { img: "app/agent-pi:1.1.0", model: "mock/mock-model", extraEnv: { ANTHROPIC_API_KEY: "unused" }, files: { ".pi/agent/models.json": JSON.stringify({ providers: { mock: { baseUrl: `${M}/v1`, api: "openai-completions", apiKey: "mock-key-0000", models: [{ id: "mock-model" }] } } }) } },
  droid: { img: "app/agent-droid:0.238.0", model: "custom:mock-model", extraEnv: { FACTORY_API_KEY: "unused" }, files: { ".factory/settings.json": JSON.stringify({ customModels: [{ model: "mock-model", displayName: "Mock", baseUrl: `${M}/v1`, apiKey: "mock-key-0000", provider: "generic-chat-completion-api", maxOutputTokens: 4096 }] }) } },
  antigravity: { img: "app/agent-antigravity:1.3.3", model: "default", extraEnv: { GEMINI_API_KEY: "mock-gemini-key-0000", GOOGLE_GEMINI_BASE_URL: M } },
};

const only = process.argv.slice(2);
let fail = 0;
for (const [h, c] of Object.entries(CASES)) {
  if (only.length && !only.includes(h)) continue;
  const a = getAdapter(h);
  const pod = `e2e-${h}`;
  spawnSync("docker", ["rm", "-f", pod]);
  execFileSync("docker", ["run", "-d", "--name", pod, "--network", "host", c.img]);
  for (const [rel, content] of Object.entries(c.files ?? {}))
    execFileSync("docker", ["exec", "-i", "-u", "agent", pod, "bash", "-c", `mkdir -p "$(dirname "$HOME/${rel}")" && cat > "$HOME/${rel}"`], { input: content });
  const env = { ...a.env({ anthropic: "", openai: "" }), ...c.extraEnv };
  if (h === "qwen-code") Object.assign(env, a.env({ anthropic: "", openai: "" })); // adapter derives OPENAI_* from DASHSCOPE_*
  const run = (argv: string[], input: string) => {
    const keys = Object.keys(env);
    // Same shape as core/runners.ts dockerExecHarness: env -i with only the harness env, as user agent, in the workdir.
    const script = `exec env -i HOME=/home/agent PATH=/home/agent/.npm-global/bin:/usr/local/bin:/usr/bin:/bin ${keys.map((k) => `${k}="$${k}"`).join(" ")} "$@"`;
    const r = spawnSync("docker", ["exec", "-i", "-u", "agent", "-w", "/home/agent/work", ...keys.flatMap((k) => ["-e", k]), pod, "bash", "-c", script, "run", ...argv],
      { input, env: { ...process.env, ...env }, encoding: "utf8", timeout: 180_000 });
    const d = a.newDigest();
    for (const l of (r.stdout ?? "").split("\n")) { try { const ev = JSON.parse(l); if (ev && typeof ev === "object") d.observe(ev); } catch {} }
    return { d: d.result(), code: r.status, err: (r.stderr ?? "").slice(-300) };
  };
  // qwen: the adapter reads DASHSCOPE_* from the worker env when building env().
  if (h === "qwen-code") { process.env.DASHSCOPE_API_KEY = "mock-key-0000"; process.env.DASHSCOPE_BASE_URL = `${M}/v1`; Object.assign(env, a.env({ anthropic: "", openai: "" })); }
  const r1 = run(a.launchArgv({ model: c.model, workdir: "/home/agent/work" }), "Please add left-pad to this project.");
  const ok1 = r1.d.lastText === "Installed left-pad with npm. Done." && r1.d.commands.some((x) => x.includes("npm install left-pad"));
  let line = `${h.padEnd(12)} launch ${ok1 ? "OK" : "FAIL"} sid=${r1.d.sessionId ?? "-"}`;
  let ok2 = true;
  if (a.canResume && r1.d.sessionId) {
    const r2 = run(a.resumeArgv({ model: c.model, workdir: "/home/agent/work", sessionId: r1.d.sessionId }), "Thanks, anything else?");
    ok2 = r2.d.sessionId === r1.d.sessionId && !!r2.d.lastText;
    line += ` | resume ${ok2 ? "OK (same session)" : `FAIL ${JSON.stringify(r2.d).slice(0, 200)} ${r2.err}`}`;
  }
  if (!ok1) line += ` ${JSON.stringify(r1.d).slice(0, 300)} code=${r1.code} ${r1.err}`;
  console.log(line);
  if (!ok1 || !ok2) fail++;
  spawnSync("docker", ["rm", "-f", pod]);
}
process.exit(fail ? 1 : 0);
